import { readFileSync, statSync } from 'node:fs';
import { CARD_BACKGROUND_COMMAND_MAX, CARD_ENV_ID } from '@agentdock/shared';
import {
  type HookCliName,
  hookCliNameSchema,
  hooksDisabled,
} from '@agentdock/shared/protocol';
import {
  cardsDirOf,
  compactRefreshOwed,
  HANDOFF_REFRESH_TEXT,
  noteIsStale,
  sessionCardNote,
  sessionNoteContext,
} from '../handoff/context';
import { connectLocal, type LocalClient } from '../local/client';
import type { LocalCommandDeps } from '../local/subcommand';
import { LOCAL_LINE_MAX_BYTES, type LocalEventArgs } from '../local/types';
import { readAncestors } from './ancestors';
import {
  runningBackgroundTasks,
  shortenCommand,
  TRANSCRIPT_MAX_BYTES,
} from './background';
import {
  commonInputSchema,
  permissionRequestInputSchema,
  sessionStartInputSchema,
  stopInputSchema,
} from './input';
import {
  buildHookEvent,
  HOOK_RAW_CONTENT_CHARS,
  type HookExtras,
  stringify,
} from './map';
import { awaitRemoteDecision, permissionOutput } from './permission';

/** `git rev-parse` in the session's cwd gives up after this long (D11). */
export const GIT_BRANCH_TIMEOUT_MS = 500;

export interface HookDeps extends LocalCommandDeps {
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Tests point it at a fake `/proc`. */
  readFile?: (path: string) => string;
  /** The daemon's card store (#449 D6); `cardsDirOf(env)` by default. */
  cardsDir?: string;
}

/**
 * #449 D6, D8: the card's handoff note for a session that starts in a card's
 * worktree or on its branch — a person's own session at every start, the
 * card's worker only after a compaction (its round prompt carries the rest),
 * with one line asking to refresh a note older than the last commit. For the
 * worker that line is the round's one request, owed when the daemon found the
 * note stale before the compaction (#494). Read from the machine, never from
 * the API; '' for any other session.
 */
const sessionNote = async (
  input: unknown,
  cwd: string,
  deps: HookDeps,
): Promise<string> => {
  try {
    const start = sessionStartInputSchema.safeParse(input);
    const compact = start.success && start.data.source === 'compact';
    if (deps.env[CARD_ENV_ID] && !compact) return '';
    const cardsDir = deps.cardsDir ?? cardsDirOf(deps.env);
    const found = await sessionCardNote(cardsDir, cwd, deps.exec);
    if (!found) return '';
    const worker = Boolean(deps.env[CARD_ENV_ID]);
    const owed = worker && compactRefreshOwed(cardsDir, found.record);
    if (!found.note) return owed ? HANDOFF_REFRESH_TEXT : '';
    const stale = worker
      ? owed
      : compact && (await noteIsStale(found.record, deps.exec));
    return sessionNoteContext(found, { stale });
  } catch {
    return '';
  }
};

const printSessionContext = (deps: HookDeps, text: string): void => {
  deps.stdout(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: text,
      },
    })}\n`,
  );
};

const readStdin = async (stream: ReadableStream<Uint8Array>): Promise<string> =>
  new Response(stream).text();

const gitBranch = async (
  deps: HookDeps,
  cwd: string,
): Promise<string | undefined> => {
  const result = await deps.exec(
    'git',
    ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'],
    { timeoutMs: GIT_BRANCH_TIMEOUT_MS },
  );
  const branch = result?.code === 0 ? result.stdout.trim() : '';
  // Detached HEAD answers `HEAD`: no branch.
  return branch && branch !== 'HEAD' && branch.length <= 255
    ? branch
    : undefined;
};

/**
 * #390: the background tasks still running at a stop, from the session's
 * transcript; undefined when it cannot be read — the API then treats the
 * stop as it always did.
 */
const readBackground = (
  input: unknown,
  deps: HookDeps,
): HookExtras['background'] => {
  const stop = stopInputSchema.safeParse(input);
  const path = stop.success ? stop.data.transcript_path : undefined;
  if (!path?.startsWith('/')) return undefined;
  try {
    if (statSync(path).size > TRANSCRIPT_MAX_BYTES) return undefined;
    const read = deps.readFile ?? ((p: string) => readFileSync(p, 'utf8'));
    const running = runningBackgroundTasks(read(path));
    const newest = running.at(-1)?.command;
    return {
      tasks: running.length,
      command: newest
        ? shortenCommand(newest, CARD_BACKGROUND_COMMAND_MAX)
        : null,
    };
  } catch {
    return undefined;
  }
};

/**
 * Builds the event under the socket's line limit: a tool output can be large,
 * so the raw content is cut harder until the line fits, and dropped last.
 */
const fitEvent = (
  name: HookCliName,
  input: unknown,
  extras: HookExtras,
): LocalEventArgs | null => {
  for (const cap of [HOOK_RAW_CONTENT_CHARS, 8 * 1024, 1024, 0]) {
    const event = buildHookEvent(name, input, extras, cap);
    if (!event) return null;
    const fitted = cap === 0 ? { ...event, content: undefined } : event;
    const size = Buffer.byteLength(
      JSON.stringify({ id: 'l1', op: 'event', args: fitted }),
    );
    if (size < LOCAL_LINE_MAX_BYTES) return fitted;
  }
  return null;
};

/**
 * `agentdock-runner hook <name>` (spec 201 D11–D13, D16, D17): reads the hook
 * JSON from stdin and reports it to the daemon. Always exits 0 — a broken
 * runner must never break a Claude Code session — and prints nothing unless
 * it has a `SessionStart` context or a permission decision to give.
 */
export const runHook = async (
  args: readonly string[],
  deps: HookDeps,
): Promise<number> => {
  // A card-capture extraction (#244 D4) must not become a captured session.
  if (hooksDisabled(deps.env)) return 0;
  const name = hookCliNameSchema.safeParse(args[0]);
  if (!name.success || args.length !== 1) {
    deps.stderr(`agentdock-runner hook: unknown hook ${args.join(' ')}\n`);
    return 0;
  }
  let input: unknown;
  try {
    input = JSON.parse(await readStdin(deps.stdin()));
  } catch {
    return 0;
  }
  const common = commonInputSchema.safeParse(input);
  if (!common.success) return 0;

  // #449 D6: the note is on this machine; it reaches the session with the
  // daemon down too.
  const note =
    name.data === 'session-start'
      ? await sessionNote(input, common.data.cwd, deps)
      : '';
  const client = await connectLocal(deps.socketPath);
  if (!client) {
    if (note) printSessionContext(deps, note);
    return 0;
  }
  try {
    await handle(name.data, input, common.data, client, deps, note);
  } finally {
    client.close();
  }
  return 0;
};

const handle = async (
  name: HookCliName,
  input: unknown,
  common: { session_id: string; cwd: string },
  client: LocalClient,
  deps: HookDeps,
  note: string,
): Promise<void> => {
  const extras: HookExtras = {};
  if (name === 'session-start') {
    const [branch, ancestors] = await Promise.all([
      gitBranch(deps, common.cwd),
      readAncestors(deps.ppid, {
        os: deps.os,
        exec: deps.exec,
        readFile: deps.readFile,
      }),
    ]);
    if (branch) extras.gitBranch = branch;
    extras.ancestors = ancestors;
    const tmux = deps.env.AGENTDOCK_TMUX_SESSION;
    if (tmux) extras.tmuxSession = tmux;
  }
  if (name === 'stop') {
    const background = readBackground(input, deps);
    if (background) extras.background = background;
  }

  const event = fitEvent(name, input, extras);
  if (event) await client.event(event);

  if (name === 'session-start') {
    const context = await client.request(
      'context.sessionStart',
      extras.gitBranch ? { gitBranch: extras.gitBranch } : {},
      { via: 'hook', cwd: common.cwd, sessionId: common.session_id },
    );
    const text = [context.ok ? context.data.text.trim() : '', note]
      .filter((part) => part.length > 0)
      .join('\n\n');
    if (text) printSessionContext(deps, text);
    return;
  }

  if (name === 'permission-request') {
    const ping = await client.ping({ cwd: common.cwd });
    // Away mode off (or unknown): no decision, the local dialog shows (D17).
    if (!ping.ok || !ping.data.awayMode || !ping.data.online) return;
    const request = permissionRequestInputSchema.safeParse(input);
    if (!request.success) return;
    const decision = await awaitRemoteDecision({
      client,
      cwd: common.cwd,
      sessionId: common.session_id,
      toolName: request.data.tool_name.slice(0, 200),
      // Cut well above the 500-character cap: the daemon redacts, then cuts.
      toolInput: stringify(request.data.tool_input)?.slice(0, 8 * 1024),
      sleep: deps.sleep ?? ((ms) => Bun.sleep(ms)),
      now: deps.now ?? Date.now,
    });
    if (decision) deps.stdout(`${permissionOutput(decision)}\n`);
  }
};

import { basename, dirname, join } from 'node:path';
import { CARD_ENV_ID, CARD_ENV_PORT } from '@agentdock/shared';
import type {
  CardRunArgs,
  CardSession,
  OrchestratorPermissionMode,
} from '@agentdock/shared/protocol';
import type { ConfigProfile } from '../config';
import { runEnv } from '../skills/run/launch';
import type { LaunchSpec } from '../skills/run/record';
import type { CardWiringFiles } from './wiring';

/** The Claude CLI's `--permission-mode` value for each protocol mode (as spec 17 D3). */
const CLI_PERMISSION_MODE: Record<OrchestratorPermissionMode, string> = {
  auto: 'auto',
  acceptEdits: 'acceptEdits',
  bypassPermissions: 'bypassPermissions',
  manual: 'default',
};

/** D5: `<parent>/.wt-<repo>-card-<shortid>`, beside the main checkout. */
export const cardWorktreePath = (root: string, shortId: string): string => {
  const trimmed = root.replace(/\/+$/, '');
  return join(dirname(trimmed), `.wt-${basename(trimmed)}-card-${shortId}`);
};

/** #389: the first port `cardPort` hands out; below Linux's ephemeral range. */
export const CARD_PORT_BASE = 20000;
/** #389: how many ports `cardPort` spreads cards over. */
export const CARD_PORT_SPAN = 10000;

/**
 * #389: the port a card's worker gives a server it starts — the same on every
 * round of the card, and another card's only by a hash collision (FNV-1a of
 * the short id).
 */
export const cardPort = (shortId: string): number => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < shortId.length; i += 1) {
    hash ^= shortId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return CARD_PORT_BASE + (hash % CARD_PORT_SPAN);
};

/**
 * #389: what the card's session is told about itself, so its tests and
 * servers keep to a database and a port of their own. The project's own test
 * setup reads `AGENTDOCK_CARD` (AgentDock's: `apps/api/src/test`); the prompt
 * names both.
 */
export const cardEnv = (shortId: string): Record<string, string> => ({
  [CARD_ENV_ID]: shortId,
  [CARD_ENV_PORT]: String(cardPort(shortId)),
});

/** D5: round 1 fixes the session id the API chose; a later round resumes it. */
export const cardSessionFlags = (session: CardSession): string[] =>
  session.resume ? ['--resume', session.id] : ['--session-id', session.id];

/**
 * D5: the profile's binary and args, the session, model and permission mode,
 * then the prompt as one argv element after `--`, so a prompt that starts
 * with `-` is never read as a flag. No `-p`: the worker is interactive, and
 * `claude [options] -- <prompt>` starts the session with that prompt
 * submitted — with `--resume` too (checked against Claude Code 2.1.300).
 */
export const cardArgv = (
  profile: ConfigProfile,
  args: Pick<CardRunArgs, 'session' | 'model' | 'permissionMode' | 'prompt'>,
  wiring?: CardWiringFiles,
): { binary: string; args: string[] } => ({
  binary: profile.binary ?? profile.runtime,
  args: [
    ...profile.args,
    ...cardSessionFlags(args.session),
    // #367 D1: the round's hooks and MCP server, when the profile has no
    // plugin. Checked against Claude Code 2.1.301: both load on
    // `--session-id` and on `--resume`.
    ...(wiring
      ? ['--settings', wiring.settings, '--mcp-config', wiring.mcp]
      : []),
    '--model',
    args.model,
    '--permission-mode',
    CLI_PERMISSION_MODE[args.permissionMode],
    '--',
    args.prompt,
  ],
});

/**
 * What `exec-run` starts in the card's tmux session. The round's `runId` is
 * in the resource attributes, so the cost of a resumed session is booked to
 * the round that resumed it; the card's own env (#389) is set over the
 * profile's.
 */
export const cardLaunchSpec = (
  profile: ConfigProfile,
  args: Pick<
    CardRunArgs,
    | 'session'
    | 'model'
    | 'permissionMode'
    | 'prompt'
    | 'projectId'
    | 'runId'
    | 'shortId'
  >,
  worktree: string,
  otlpPort: number | null,
  wiring?: CardWiringFiles,
): LaunchSpec => ({
  ...cardArgv(profile, args, wiring),
  env: { ...runEnv(profile, args, otlpPort), ...cardEnv(args.shortId) },
  cwd: worktree,
  interactive: true,
});

import { randomBytes } from 'node:crypto';
import { open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  SlotMessageArgs,
  SlotMessageResult,
  SlotStopArgs,
  StoppedResult,
} from '@agentdock/shared/protocol';
import { isoNow } from '../clock';
import type { ControlDeps } from './deps';
import { resolveSlot, watchedProject } from './target';
import { TmuxControl } from './tmux';

/** The file the orchestrator skill writes to a worker (Phase 6.5). */
export const MESSAGE_FILE = '.orchestrator-msg.md';
/** What the worker is told to do, typed literally into its pane (D7). */
export const MESSAGE_PROMPT =
  'Read ./.orchestrator-msg.md and reply into ./.orchestrator-reply.md';

const target = async (deps: ControlDeps, args: SlotStopArgs) => {
  const project = watchedProject(args, deps.watchedProjects());
  const tmux = new TmuxControl(deps.exec, deps.tmuxServer);
  return { tmux, slot: await resolveSlot(deps.exec, tmux, project, args.slot) };
};

/**
 * `slot.stop` (D6): kills the slot's session. The worktree, branch and commits
 * are left alone; the orchestrator resumes or cleans up.
 */
export const stopSlot = async (
  args: SlotStopArgs,
  deps: ControlDeps,
): Promise<StoppedResult> => {
  const { tmux, slot } = await target(deps, args);
  for (const session of slot.sessions) await tmux.killSession(session);
  return { stopped: slot.sessions.length > 0 };
};

export const messageFileContent = (
  args: Pick<SlotMessageArgs, 'from' | 'text'>,
  at: string,
): string =>
  `From: ${args.from} via AgentDock\nDate: ${at}\n\n${args.text.replace(/\n*$/, '\n')}`;

/**
 * Replaces `path` atomically: a new file beside it (`wx`, so nothing existing
 * is followed or reused), then `rename`, which replaces a symlink at `path`
 * rather than writing through it.
 */
export const writeAtomically = async (
  path: string,
  content: string,
): Promise<void> => {
  const temp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  const handle = await open(temp, 'wx', 0o600);
  try {
    await handle.writeFile(content, 'utf8');
  } finally {
    await handle.close();
  }
  try {
    await rename(temp, path);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
};

/**
 * `slot.message` (D7): writes the message file in the slot's worktree, then —
 * when the worker's session is live — types the prompt and, as a separate
 * call, Enter. The file is always written; `delivered` says whether the
 * worker was told.
 */
export const messageSlot = async (
  args: SlotMessageArgs,
  deps: ControlDeps,
): Promise<SlotMessageResult> => {
  const { tmux, slot } = await target(deps, args);
  await writeAtomically(
    join(slot.worktree, MESSAGE_FILE),
    messageFileContent(args, isoNow(deps.clock)),
  );
  const [session] = slot.sessions;
  if (!session) return { written: true, delivered: false };
  await tmux.sendLiteral(session, MESSAGE_PROMPT);
  await tmux.sendEnter(session);
  return { written: true, delivered: true };
};

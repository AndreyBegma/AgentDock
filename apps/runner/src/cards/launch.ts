import { basename, dirname, join } from 'node:path';
import type {
  CardRunArgs,
  CardSession,
  OrchestratorPermissionMode,
} from '@agentdock/shared/protocol';
import type { ConfigProfile } from '../config';
import { runEnv } from '../skills/run/launch';
import type { LaunchSpec } from '../skills/run/record';

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
): { binary: string; args: string[] } => ({
  binary: profile.binary ?? profile.runtime,
  args: [
    ...profile.args,
    ...cardSessionFlags(args.session),
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
 * the round that resumed it.
 */
export const cardLaunchSpec = (
  profile: ConfigProfile,
  args: Pick<
    CardRunArgs,
    'session' | 'model' | 'permissionMode' | 'prompt' | 'projectId' | 'runId'
  >,
  worktree: string,
  otlpPort: number | null,
): LaunchSpec => ({
  ...cardArgv(profile, args),
  env: runEnv(profile, args, otlpPort),
  cwd: worktree,
  interactive: true,
});

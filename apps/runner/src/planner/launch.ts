import { basename, dirname, join } from 'node:path';
import type { PlanTurnArgs, PlanTurnSession } from '@agentdock/shared/protocol';
import type { ConfigProfile } from '../config';
import { runEnv } from '../skills/run/launch';
import type { LaunchSpec } from '../skills/run/record';

/** D15: `<parent>/.wt-<repo>-plan-<shortid>`, beside the main checkout. */
export const planWorktreePath = (root: string, shortId: string): string => {
  const trimmed = root.replace(/\/+$/, '');
  return join(dirname(trimmed), `.wt-${basename(trimmed)}-plan-${shortId}`);
};

/** The tmux session of one turn; `plan.cancel` kills it. */
export const planTurnSessionName = (shortId: string): string =>
  `agentdock-plan-${shortId}`;

/**
 * D3: which session the turn runs in.
 * - first plan turn: `--session-id <id>`;
 * - later turns: `--resume <id>`;
 * - a task's first turn: `--resume <forkFrom> --fork-session --session-id <id>`,
 *   so the fork's id is the one the API chose.
 */
export const sessionFlags = (session: PlanTurnSession): string[] => {
  if (session.forkFrom) {
    return [
      '--resume',
      session.forkFrom,
      '--fork-session',
      '--session-id',
      session.id,
    ];
  }
  return session.resume
    ? ['--resume', session.id]
    : ['--session-id', session.id];
};

/**
 * D3, D15, D16: the profile's binary and args, then the headless flags. The
 * prompt is not here: it reaches `claude -p` on stdin from `prompt.md`.
 * `--permission-mode plan`: the planner reads the code and writes nothing.
 */
export const planTurnArgv = (
  profile: ConfigProfile,
  args: Pick<PlanTurnArgs, 'session' | 'model'>,
): { binary: string; args: string[] } => ({
  binary: profile.binary ?? profile.runtime,
  args: [
    ...profile.args,
    '-p',
    ...sessionFlags(args.session),
    '--model',
    args.model,
    '--permission-mode',
    'plan',
    '--output-format',
    'stream-json',
    '--verbose',
  ],
});

export const planTurnLaunchSpec = (
  profile: ConfigProfile,
  args: Pick<PlanTurnArgs, 'session' | 'model' | 'projectId' | 'runId'>,
  worktree: string,
  promptFile: string,
  otlpPort: number | null,
): LaunchSpec => ({
  ...planTurnArgv(profile, args),
  env: runEnv(profile, args, otlpPort),
  cwd: worktree,
  stdin: promptFile,
});

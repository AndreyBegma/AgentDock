import { randomBytes } from 'node:crypto';
import type { WatchedProject } from '@agentdock/shared/protocol';
import type { Clock } from '../clock';
import { CommandFailure } from '../commands/failure';
import type { ConfigProfile } from '../config';
import type { Exec, ExecResult } from '../detect/exec';
import type { SourceDeps } from './source';

/** What the skill commands need from the runner (spec 24). */
export interface SkillsDeps extends SourceDeps {
  exec: Exec;
  clock: Clock;
  /** The user's home: profile directories default under it. */
  home: string;
  profiles: () => readonly ConfigProfile[];
  watchedProjects: () => readonly WatchedProject[];
  /** Short ids of worktrees and sessions; random by default. */
  shortId?: () => string;
}

/** Local git work against a project; fetch, push and `gh` take longer. */
export const GIT_TIMEOUT_MS = 30_000;
export const NETWORK_TIMEOUT_MS = 60_000;
export const GH_TIMEOUT_MS = 40_000;

/** `[a-z0-9]{8}` — what `skillRunShortIdSchema` accepts. */
export const randomShortId = (): string => {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  return [...randomBytes(8)].map((b) => alphabet[b % 36]).join('');
};

export const profileOf = (
  deps: Pick<SkillsDeps, 'profiles'>,
  profileKey: string,
): ConfigProfile => {
  const profile = deps.profiles().find((p) => p.id === profileKey);
  if (!profile) {
    throw new CommandFailure(
      'unknown_profile',
      `no profile ${profileKey} in the runner config`,
    );
  }
  return profile;
};

export const stderrLine = (result: ExecResult | null): string =>
  result
    ? (result.stderr.trim().split('\n').at(-1) ?? '').slice(0, 300)
    : 'not available or timed out';

/** Runs git and throws with its last stderr line unless it exits 0. */
export const gitOk = async (
  exec: Exec,
  args: readonly string[],
  timeoutMs = GIT_TIMEOUT_MS,
): Promise<string> => {
  const result = await exec('git', args, { timeoutMs });
  if (!result || result.code !== 0) {
    throw new Error(
      `git ${args.slice(2, 4).join(' ')} failed: ${stderrLine(result)}`,
    );
  }
  return result.stdout;
};

/** Runs git and answers whether it exited 0; never throws. */
export const gitSucceeds = async (
  exec: Exec,
  args: readonly string[],
  timeoutMs = GIT_TIMEOUT_MS,
): Promise<boolean> => {
  const result = await exec('git', args, { timeoutMs });
  return result?.code === 0;
};

/**
 * The runner's own commits (D4, D10): the project's hooks do not run — no
 * third-party code, no hook adding an attribution trailer.
 */
export const NO_HOOKS = ['-c', 'core.hooksPath=/dev/null'];

const PR_URL = /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/(\d+)\s*$/m;

/** The URL `gh pr create` prints, and the number in it. */
export const parsePrUrl = (
  stdout: string,
): { number: number; url: string } | null => {
  const match = PR_URL.exec(stdout);
  return match ? { number: Number(match[1]), url: match[0].trim() } : null;
};

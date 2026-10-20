import { randomBytes } from 'node:crypto';
import { MANUAL_TMUX_SESSION_PREFIX } from '@nautelle/shared/protocol';
import type { LocalCommandDeps } from '../local/subcommand';

/** Runs a binary with the terminal's own stdio; resolves its exit code. */
export type RunInherited = (
  binary: string,
  args: readonly string[],
  options: { cwd: string },
) => Promise<number>;

export interface ClaudeIo {
  /** Whether stdin is a terminal (`process.stdin.isTTY`). */
  isTTY: boolean;
  runInherited: RunInherited;
  /** A fresh session name suffix: 8 lowercase hex characters. */
  suffix: () => string;
}

const defineEnv = (env: LocalCommandDeps['env']): Record<string, string> =>
  Object.fromEntries(
    Object.entries(env).filter(
      (e): e is [string, string] => e[1] !== undefined,
    ),
  );

const inheritedRunner =
  (env: LocalCommandDeps['env']): RunInherited =>
  async (binary, args, options) => {
    const path = Bun.which(binary, { PATH: env.PATH ?? '' });
    if (!path) return 127;
    const proc = Bun.spawn([path, ...args], {
      cwd: options.cwd,
      env: defineEnv(env),
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
    });
    return await proc.exited;
  };

const defaultIo = (deps: LocalCommandDeps): ClaudeIo => ({
  isTTY: process.stdin.isTTY === true,
  runInherited: inheritedRunner(deps.env),
  suffix: () => randomBytes(4).toString('hex'),
});

/**
 * `agentdock-runner claude [-- <args>]` (spec 201 D23): `claude` in an
 * `agentdock-manual-<hex>` tmux session the browser can attach to. Without a
 * terminal or without tmux it is plain `claude <args>`. Every command is an
 * argv, never a shell string; `AGENTDOCK_TMUX_SESSION` tells the
 * `SessionStart` hook which session to report.
 */
export const runClaude = async (
  args: readonly string[],
  deps: LocalCommandDeps,
  io: ClaudeIo = defaultIo(deps),
): Promise<number> => {
  const claudeArgs = args[0] === '--' ? args.slice(1) : args;
  const options = { cwd: deps.cwd };
  const hasTmux = io.isTTY && (await deps.exec('tmux', ['-V']))?.code === 0;
  if (!hasTmux) return io.runInherited('claude', claudeArgs, options);

  const name = `${MANUAL_TMUX_SESSION_PREFIX}${io.suffix()}`;
  const created = await deps.exec('tmux', [
    'new-session',
    '-d',
    '-s',
    name,
    '-c',
    deps.cwd,
    '-e',
    `AGENTDOCK_TMUX_SESSION=${name}`,
    'claude',
    ...claudeArgs,
  ]);
  if (!created || created.code !== 0) {
    deps.stderr(
      `agentdock-runner: cannot start tmux session ${name}: ${created?.stderr.trim() || 'tmux failed'}\n`,
    );
    return 1;
  }
  return io.runInherited('tmux', ['attach-session', '-t', name], options);
};

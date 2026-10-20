import { randomBytes } from 'node:crypto';
import type { Exec } from '../detect/exec';
import type { Env } from '../env';
import type { Logger } from '../log';

/** Global tmux flags that take a value: they select or configure the server. */
const FLAGS_WITH_VALUE = new Set(['-L', '-S', '-f', '-c', '-T']);

/**
 * Splits a tmux argv into its global flags (the server selection) and the
 * command with its arguments. `-L x new-session -d …` → `['-L', 'x']`,
 * `'new-session'`.
 */
const splitTmuxArgs = (
  args: readonly string[],
): { server: readonly string[]; command: string | undefined } => {
  let i = 0;
  while (i < args.length) {
    const arg = args[i] ?? '';
    if (!arg.startsWith('-')) break;
    i += FLAGS_WITH_VALUE.has(arg) ? 2 : 1;
  }
  return { server: args.slice(0, i), command: args[i] };
};

export interface TmuxServerGuardOptions {
  env: Env;
  log: Logger;
  platform?: NodeJS.Platform;
  uid?: number;
  suffix?: () => string;
}

/**
 * #327: keeps the tmux server out of the runner unit's cgroup. A `stop` or
 * `restart` of the unit (every upgrade, ADR-0017) kills every process in that
 * cgroup; a server the runner forked with its first `new-session` lives there,
 * and every card worker and orchestrator slot dies with it.
 *
 * Under systemd (`INVOCATION_ID`), a `new-session` with no server running is
 * run inside a transient scope of its own, so the server it forks lives there.
 * It is the `new-session` and not a bare `start-server`: with tmux's default
 * `exit-empty`, a server started without a session exits at once. `--collect`
 * removes the scope when the server exits. A server that already runs, in any
 * cgroup, is reused. Without systemd (launchd, a plain shell) nothing changes.
 *
 * Every tmux child of the runner goes through `wrap`, as git's do through
 * `GitAuth.wrap`: the call sites stay unchanged.
 */
export class TmuxServerGuard {
  private readonly underSystemd: boolean;
  private readonly uid: number | undefined;
  private readonly suffix: () => string;
  /** `systemd-run` was not found; it is not looked for again. */
  private systemdRunMissing = false;
  private warned = false;

  constructor(private readonly options: TmuxServerGuardOptions) {
    const platform = options.platform ?? process.platform;
    this.underSystemd =
      platform === 'linux' && (options.env.INVOCATION_ID ?? '') !== '';
    this.uid = options.uid ?? process.getuid?.();
    this.suffix = options.suffix ?? (() => randomBytes(4).toString('hex'));
  }

  wrap(exec: Exec): Exec {
    return async (binary, args, execOptions) => {
      if (binary !== 'tmux' || !this.underSystemd || this.systemdRunMissing) {
        return exec(binary, args, execOptions);
      }
      const { server, command } = splitTmuxArgs(args);
      if (command !== 'new-session') return exec(binary, args, execOptions);

      const running = await exec('tmux', [...server, 'list-sessions']);
      if (running?.code === 0) return exec(binary, args, execOptions);

      const unit = `nautelle-tmux-${this.uid ?? 'user'}-${this.suffix()}`;
      const scoped = await exec(
        'systemd-run',
        [
          '--user',
          '--scope',
          '--collect',
          '--quiet',
          '--unit',
          unit,
          'tmux',
          ...args,
        ],
        execOptions,
      );
      if (scoped?.code === 0) {
        this.options.log.info('tmux: server started in its own scope', {
          unit: `${unit}.scope`,
        });
        return scoped;
      }
      if (!scoped) this.systemdRunMissing = true;
      this.warnOnce(scoped?.stderr.trim() || 'systemd-run is not available');
      return exec(binary, args, execOptions);
    };
  }

  private warnOnce(reason: string) {
    if (this.warned) return;
    this.warned = true;
    this.options.log.warn(
      'tmux: cannot start the server outside the runner unit; a restart of the unit will kill its sessions',
      { reason },
    );
  }
}

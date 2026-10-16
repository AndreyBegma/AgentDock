import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/** Where tmux keeps the sockets of `-L <name>` servers. */
export const socketDir = () =>
  join(process.env.TMUX_TMPDIR ?? '/tmp', `tmux-${process.getuid?.() ?? 0}`);

/** Every private test server's name carries the pid of the run that started it. */
export const TEST_SERVER = /^agentdock-(?:[a-z]+-)*test-(\d+)-/;

const killServer = async (name: string) => {
  const proc = Bun.spawn(['tmux', '-L', name, 'kill-server'], {
    stdout: 'ignore',
    stderr: 'ignore',
  });
  await proc.exited;
};

/**
 * Stops a test's private tmux server and removes its socket. `kill-server`
 * alone leaves the socket file behind, one per test run otherwise.
 */
export const releaseTmuxServer = async (tmuxServer: readonly string[]) => {
  const name = tmuxServer[tmuxServer.indexOf('-L') + 1];
  if (!name) return;
  await killServer(name);
  rmSync(join(socketDir(), name), { force: true });
};

/** Sockets of private test servers that the run with `pid` started. */
export const leakedSockets = (pid: number): string[] => {
  try {
    return readdirSync(socketDir()).filter(
      (name) => TEST_SERVER.exec(name)?.[1] === String(pid),
    );
  } catch {
    return [];
  }
};

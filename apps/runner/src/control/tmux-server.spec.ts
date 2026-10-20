import { describe, expect, it } from 'bun:test';
import type { Exec, ExecResult } from '../detect/exec';
import type { Env } from '../env';
import { memoryLogger } from '../testing/fixtures';
import { TmuxServerGuard } from './tmux-server';

const ok: ExecResult = { code: 0, stdout: '', stderr: '' };
const noServer: ExecResult = {
  code: 1,
  stdout: '',
  stderr: 'no server running on /tmp/tmux-1000/default',
};
const SYSTEMD: Env = { INVOCATION_ID: '61ff12a3d98e4bf4bdf736ea178c90e7' };
const NEW_SESSION = ['new-session', '-d', '-s', 'nautelle-card-1', 'claude'];

/**
 * An exec stub recording every call. `server` says whether `list-sessions`
 * finds a server; `systemdRun` answers `systemd-run` (null: not installed).
 */
const machine = (opts: { server: boolean; systemdRun?: ExecResult | null }) => {
  const calls: string[][] = [];
  const exec: Exec = async (binary, args) => {
    calls.push([binary, ...args]);
    if (binary === 'systemd-run') {
      return opts.systemdRun === undefined ? ok : opts.systemdRun;
    }
    if (binary === 'tmux' && args.includes('list-sessions')) {
      return opts.server ? ok : noServer;
    }
    return ok;
  };
  return { exec, calls };
};

const guard = (env: Env, platform: NodeJS.Platform = 'linux') => {
  const { log, lines } = memoryLogger();
  const tmuxServer = new TmuxServerGuard({
    env,
    log,
    platform,
    uid: 1000,
    suffix: () => 'beef',
  });
  return { tmuxServer, lines };
};

describe('TmuxServerGuard (#327)', () => {
  it('under systemd, starts the first server through systemd-run --scope', async () => {
    const { exec, calls } = machine({ server: false });
    const { tmuxServer, lines } = guard(SYSTEMD);

    const result = await tmuxServer.wrap(exec)('tmux', NEW_SESSION);

    expect(result?.code).toBe(0);
    expect(calls).toEqual([
      ['tmux', 'list-sessions'],
      [
        'systemd-run',
        '--user',
        '--scope',
        '--collect',
        '--quiet',
        '--unit',
        'nautelle-tmux-1000-beef',
        'tmux',
        ...NEW_SESSION,
      ],
    ]);
    expect(lines.join('')).toContain('nautelle-tmux-1000-beef.scope');
  });

  it('keeps the server selection inside the scope and in the probe', async () => {
    const { exec, calls } = machine({ server: false });
    const { tmuxServer } = guard(SYSTEMD);

    await tmuxServer.wrap(exec)('tmux', ['-L', 'test-1', ...NEW_SESSION]);

    expect(calls[0]).toEqual(['tmux', '-L', 'test-1', 'list-sessions']);
    expect(calls[1]?.slice(-NEW_SESSION.length - 3)).toEqual([
      'tmux',
      '-L',
      'test-1',
      ...NEW_SESSION,
    ]);
  });

  it('reuses a server that already runs, whatever its cgroup', async () => {
    const { exec, calls } = machine({ server: true });
    const { tmuxServer } = guard(SYSTEMD);

    await tmuxServer.wrap(exec)('tmux', NEW_SESSION);

    expect(calls).toEqual([
      ['tmux', 'list-sessions'],
      ['tmux', ...NEW_SESSION],
    ]);
  });

  it('without systemd, runs plain tmux and probes nothing', async () => {
    const { exec, calls } = machine({ server: false });
    const { tmuxServer } = guard({});

    await tmuxServer.wrap(exec)('tmux', NEW_SESSION);

    expect(calls).toEqual([['tmux', ...NEW_SESSION]]);
  });

  it('on macOS, runs plain tmux even with INVOCATION_ID set', async () => {
    const { exec, calls } = machine({ server: false });
    const { tmuxServer } = guard(SYSTEMD, 'darwin');

    await tmuxServer.wrap(exec)('tmux', NEW_SESSION);

    expect(calls).toEqual([['tmux', ...NEW_SESSION]]);
  });

  it('falls back to plain tmux when systemd-run is missing, warns once, and stops looking for it', async () => {
    const { exec, calls } = machine({ server: false, systemdRun: null });
    const { tmuxServer, lines } = guard(SYSTEMD);
    const wrapped = tmuxServer.wrap(exec);

    const first = await wrapped('tmux', NEW_SESSION);
    await wrapped('tmux', NEW_SESSION);

    expect(first?.code).toBe(0);
    expect(calls.map((c) => c[0])).toEqual([
      'tmux',
      'systemd-run',
      'tmux',
      'tmux',
    ]);
    expect(lines.filter((l) => l.includes('"warn"'))).toHaveLength(1);
  });

  it('falls back to plain tmux when systemd-run fails, and warns once', async () => {
    const { exec, calls } = machine({
      server: false,
      systemdRun: { code: 1, stdout: '', stderr: 'Failed to connect to bus' },
    });
    const { tmuxServer, lines } = guard(SYSTEMD);
    const wrapped = tmuxServer.wrap(exec);

    await wrapped('tmux', NEW_SESSION);
    await wrapped('tmux', NEW_SESSION);

    expect(calls.map((c) => c[0])).toEqual([
      'tmux',
      'systemd-run',
      'tmux',
      'tmux',
      'systemd-run',
      'tmux',
    ]);
    const warns = lines.filter((l) => l.includes('"warn"'));
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('Failed to connect to bus');
  });

  it('passes every other tmux command and every other binary through', async () => {
    const { exec, calls } = machine({ server: false });
    const { tmuxServer } = guard(SYSTEMD);
    const wrapped = tmuxServer.wrap(exec);

    await wrapped('tmux', ['list-sessions', '-F', '#{session_name}']);
    await wrapped('tmux', ['send-keys', '-t', '=new-session:', 'Enter']);
    await wrapped('git', ['new-session']);

    expect(calls).toEqual([
      ['tmux', 'list-sessions', '-F', '#{session_name}'],
      ['tmux', 'send-keys', '-t', '=new-session:', 'Enter'],
      ['git', 'new-session'],
    ]);
  });
});

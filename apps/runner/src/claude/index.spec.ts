import { describe, expect, it } from 'bun:test';
import type { Exec } from '../detect/exec';
import type { LocalCommandDeps } from '../local/subcommand';
import { type ClaudeIo, runClaude } from './index';

type Call = [string, readonly string[]];

const setup = (opts: { isTTY: boolean; tmux: boolean; attach?: number }) => {
  const execCalls: Call[] = [];
  const inherited: Call[] = [];
  const exec: Exec = async (binary, args) => {
    execCalls.push([binary, args]);
    if (binary === 'tmux' && !opts.tmux) return null;
    return { code: 0, stdout: 'tmux 3.4', stderr: '' };
  };
  const deps = {
    cwd: '/home/u/dev/app',
    exec,
    stderr: () => {},
  } as unknown as LocalCommandDeps;
  const io: ClaudeIo = {
    isTTY: opts.isTTY,
    suffix: () => '0a1b2c3d',
    runInherited: async (binary, args) => {
      inherited.push([binary, args]);
      return opts.attach ?? 0;
    },
  };
  return { deps, io, execCalls, inherited };
};

describe('agentdock-runner claude (spec 201 D23)', () => {
  it('starts claude in a manual tmux session and attaches to it', async () => {
    const t = setup({ isTTY: true, tmux: true, attach: 3 });
    const code = await runClaude(['--', '--resume', 'x'], t.deps, t.io);
    expect(code).toBe(3);
    expect(t.execCalls[1]).toEqual([
      'tmux',
      [
        'new-session',
        '-d',
        '-s',
        'agentdock-manual-0a1b2c3d',
        '-c',
        '/home/u/dev/app',
        '-e',
        'AGENTDOCK_TMUX_SESSION=agentdock-manual-0a1b2c3d',
        'claude',
        '--resume',
        'x',
      ],
    ]);
    expect(t.inherited).toEqual([
      ['tmux', ['attach-session', '-t', 'agentdock-manual-0a1b2c3d']],
    ]);
  });

  it('execs claude directly without a terminal', async () => {
    const t = setup({ isTTY: false, tmux: true });
    await runClaude(['-p', 'hi'], t.deps, t.io);
    expect(t.execCalls).toEqual([]);
    expect(t.inherited).toEqual([['claude', ['-p', 'hi']]]);
  });

  it('execs claude directly without tmux', async () => {
    const t = setup({ isTTY: true, tmux: false });
    await runClaude([], t.deps, t.io);
    expect(t.inherited).toEqual([['claude', []]]);
  });

  it('fails when the tmux session cannot be created', async () => {
    const t = setup({ isTTY: true, tmux: true });
    t.deps.exec = async (_b, args) =>
      args[0] === 'new-session'
        ? { code: 1, stdout: '', stderr: 'boom' }
        : { code: 0, stdout: '', stderr: '' };
    expect(await runClaude([], t.deps, t.io)).toBe(1);
    expect(t.inherited).toEqual([]);
  });
});

import { describe, expect, it } from 'bun:test';
import type { TerminalTarget } from '@agentdock/shared/protocol';
import type { Exec } from '../detect/exec';
import { type ResolveDeps, resolveTerminalTarget } from './resolve';

const SESSION = 'agentdock-manual-0a1b2c3d';
const project = { id: 'prj_1', root: '/home/u/dev/app' };
const other = { id: 'prj_2', root: '/home/u/dev/other' };

const target: TerminalTarget = {
  kind: 'manual',
  projectId: 'prj_1',
  root: project.root,
  sessionId: 'claude-1',
};

const tmuxWith =
  (...names: string[]): Exec =>
  async (_binary, args) =>
    args.includes('list-sessions')
      ? {
          code: 0,
          stdout: names.map((n) => `${n}|:|1700000000\n`).join(''),
          stderr: '',
        }
      : { code: 0, stdout: '', stderr: '' };

const deps = (over: Partial<ResolveDeps> = {}): ResolveDeps => ({
  exec: tmuxWith(SESSION),
  watchedProjects: () => [project, other],
  manualSession: (id) =>
    id === 'claude-1'
      ? { tmuxSession: SESSION, cwd: '/home/u/dev/app/src' }
      : undefined,
  ...over,
});

const code = async (promise: Promise<unknown>) =>
  promise.then(
    () => 'resolved',
    (error: { code?: string }) => error.code,
  );

describe('resolving a manual terminal target (spec 201 D23)', () => {
  it('resolves a session the daemon recorded', async () => {
    expect(await resolveTerminalTarget(target, deps())).toBe(SESSION);
  });

  it('refuses a session id it never recorded', async () => {
    const unknown = { ...target, sessionId: 'claude-2' };
    expect(await code(resolveTerminalTarget(unknown, deps()))).toBe(
      'not_found',
    );
  });

  it('refuses a recorded name that is not agentdock-manual-<hex>', async () => {
    const bad = deps({
      manualSession: () => ({ tmuxSession: 'cs-main', cwd: project.root }),
      exec: tmuxWith('cs-main'),
    });
    expect(await code(resolveTerminalTarget(target, bad))).toBe('not_found');
  });

  it('refuses a session working in another project', async () => {
    const elsewhere = deps({
      manualSession: () => ({ tmuxSession: SESSION, cwd: other.root }),
    });
    expect(await code(resolveTerminalTarget(target, elsewhere))).toBe(
      'not_found',
    );
  });

  it('refuses a recorded session whose tmux session is gone', async () => {
    expect(
      await code(resolveTerminalTarget(target, deps({ exec: tmuxWith() }))),
    ).toBe('not_found');
  });

  it('is unsupported on a runner without the session lookup', async () => {
    expect(
      await code(
        resolveTerminalTarget(target, deps({ manualSession: undefined })),
      ),
    ).toBe('unsupported');
  });
});

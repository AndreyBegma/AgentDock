import type { WatchedProject } from '@agentdock/shared/protocol';
import type { ConfigProfile } from '../config';
import type { Exec, ExecResult } from '../detect/exec';
import { FakeClock } from '../testing/fake-clock';
import type { ControlDeps } from './deps';

/** 2026-10-08T09:00:00Z, as tmux prints `session_created`. */
export const CREATED = 1_791_450_000;

export interface FakeTmuxOptions {
  project?: WatchedProject;
  /** Session name → pane text. */
  sessions?: Record<string, string>;
  /** Worktree paths git lists for the root, besides the root itself. */
  worktrees?: string[];
  /** `origin`'s URL; none → the repo is the root's basename. */
  origin?: string | null;
  profiles?: ConfigProfile[];
  /** `new-session` answers this failure instead of creating the session. */
  newSessionFails?: ExecResult;
}

const ok = (stdout = ''): ExecResult => ({ code: 0, stdout, stderr: '' });
const fail = (stderr: string): ExecResult => ({ code: 1, stdout: '', stderr });

/** `=name` or `=name:` → name; anything else is not a target this shim knows. */
const exactTarget = (target: string | undefined): string | null =>
  target?.startsWith('=') ? target.slice(1).replace(/:$/, '') : null;

/**
 * A fake tmux server and git checkout behind one `Exec`, recording every call
 * as argv. tmux targets are honoured only in their exact `=name` form, so a
 * handler that forgets the `=` finds nothing.
 */
export const fakeTmux = (options: FakeTmuxOptions = {}) => {
  const project = options.project ?? { id: 'prj_1', root: '/srv/widget' };
  const sessions = new Map(Object.entries(options.sessions ?? {}));
  const calls: string[][] = [];
  const origin =
    options.origin === undefined
      ? 'git@github.com:acme/widget.git'
      : options.origin;

  const git = (args: readonly string[]): ExecResult => {
    if (args[0] !== '-C' || args[1] !== project.root) return fail('not here');
    const rest = args.slice(2).join(' ');
    if (rest === 'worktree list --porcelain') {
      return ok(
        [project.root, ...(options.worktrees ?? [])]
          .map((path) => `worktree ${path}\nHEAD abc\nbranch refs/heads/x\n`)
          .join('\n'),
      );
    }
    if (rest === 'remote get-url origin' && origin) return ok(`${origin}\n`);
    return fail('unsupported');
  };

  const tmux = (args: readonly string[]): ExecResult => {
    const [command, ...rest] = args;
    const target = exactTarget(rest[rest.indexOf('-t') + 1]);
    switch (command) {
      case 'list-sessions':
        if (sessions.size === 0) return fail('no server running');
        return ok(
          [...sessions.keys()].map((name) => `${name}|:|${CREATED}\n`).join(''),
        );
      case 'new-session': {
        if (options.newSessionFails) return options.newSessionFails;
        const name = rest[rest.indexOf('-s') + 1] ?? '';
        if (sessions.has(name)) return fail(`duplicate session: ${name}`);
        sessions.set(name, '');
        return ok();
      }
      case 'kill-session':
        if (!target || !sessions.delete(target)) {
          return fail(`can't find session`);
        }
        return ok();
      case 'capture-pane':
        return target && sessions.has(target)
          ? ok(sessions.get(target))
          : fail(`can't find pane`);
      case 'send-keys':
        return target && sessions.has(target) ? ok() : fail(`can't find pane`);
      default:
        return fail(`unknown command ${command}`);
    }
  };

  const exec: Exec = async (binary, args) => {
    calls.push([binary, ...args]);
    if (binary === 'git') return git(args);
    if (binary === 'tmux') return tmux(args);
    return null;
  };

  const deps: ControlDeps = {
    exec,
    clock: new FakeClock(Date.parse('2026-10-08T10:00:00.000Z')),
    watchedProjects: () => [project],
    profiles: () => options.profiles ?? [],
  };
  return {
    project,
    sessions,
    calls,
    deps,
    /** The tmux calls only, without the binary. */
    tmuxCalls: () =>
      calls.filter((c) => c[0] === 'tmux').map((c) => c.slice(1)),
  };
};

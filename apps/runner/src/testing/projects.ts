import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createExec, type Exec, type ExecResult } from '../detect/exec';
import { nodeFs, type ProjectFs } from '../projects/fs';
import { tempDir } from './fixtures';

/**
 * Per-test timeout for suites that spawn real tmux or git. Bun's 5 s default
 * is too tight on a loaded machine (load average 20–50 is routine here).
 */
export const REAL_PROCESS_TIMEOUT_MS = 20_000;

/** git with no user or system config, so fixtures behave the same everywhere. */
export const realGit = (home: string): Exec =>
  createExec({
    PATH: process.env.PATH,
    HOME: home,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
  });

/** Real git, and `gh` answered from a table (`args joined` → stdout); unlisted → exit 1. */
export const gitWithFakeGh =
  (git: Exec, gh: Record<string, string> = {}): Exec =>
  async (binary, args) => {
    if (binary !== 'gh') return git(binary, args);
    const answer = gh[args.join(' ')];
    const result: ExecResult =
      answer === undefined
        ? { code: 1, stdout: '', stderr: 'not found' }
        : { code: 0, stdout: `${answer}\n`, stderr: '' };
    return result;
  };

/** A workspace folder: the parent the project and its siblings live in. */
export const workspace = () => {
  const { dir, cleanup } = tempDir();
  const ws = realpathSync(dir);
  const git = realGit(ws);

  const run = async (cwd: string, ...args: string[]) => {
    const result = await git('git', ['-C', cwd, ...args]);
    if (!result || result.code !== 0) {
      throw new Error(`git ${args.join(' ')}: ${result?.stderr}`);
    }
    return result.stdout.trim();
  };

  /** Writes files (paths relative to the workspace); a trailing `/` makes a folder. */
  const files = (entries: Record<string, string>) => {
    for (const [path, content] of Object.entries(entries)) {
      const full = join(ws, path);
      if (path.endsWith('/')) {
        mkdirSync(full, { recursive: true });
      } else {
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, content);
      }
    }
  };

  /** `git init` a folder of the workspace, with an optional origin. */
  const repo = async (path: string, origin?: string) => {
    const full = join(ws, path);
    mkdirSync(full, { recursive: true });
    await run(full, 'init', '-q', '-b', 'main');
    if (origin) await run(full, 'remote', 'add', 'origin', origin);
    return full;
  };

  const commit = (path: string) =>
    run(
      join(ws, path),
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@t',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'init',
    );

  return { ws, git, run, files, repo, commit, cleanup };
};

export interface FsAccess {
  method: keyof ProjectFs;
  path: string;
}

/** The real filesystem, recording every path it is asked about. */
export const spyFs = (): { fs: ProjectFs; accesses: FsAccess[] } => {
  const accesses: FsAccess[] = [];
  const record =
    <M extends keyof ProjectFs>(method: M) =>
    (path: string) => {
      accesses.push({ method, path });
      return (nodeFs[method] as (p: string) => ReturnType<ProjectFs[M]>)(path);
    };
  return {
    accesses,
    fs: {
      stat: record('stat'),
      isSymbolicLink: record('isSymbolicLink'),
      realpath: record('realpath'),
      readdir: record('readdir'),
      readFile: record('readFile'),
    },
  };
};

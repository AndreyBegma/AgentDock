import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { WatchedProject } from '@agentdock/shared/protocol';
import type { ConfigProfile } from '../config';
import { createExec, type Exec, type ExecResult } from '../detect/exec';
import { FakeClock } from '../testing/fake-clock';
import { tempDir } from '../testing/fixtures';
import type { SkillsDeps } from './deps';

/** git with no user or system config and a fixed identity, so commits work anywhere. */
export const isolatedGit = (home: string): Exec =>
  createExec(
    {
      PATH: process.env.PATH,
      HOME: home,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'Runner',
      GIT_AUTHOR_EMAIL: 'runner@example.test',
      GIT_COMMITTER_NAME: 'Runner',
      GIT_COMMITTER_EMAIL: 'runner@example.test',
    },
    15_000,
  );

export interface GhCall {
  args: string[];
  /** The `--body-file` content, read when the call was made. */
  body: string | null;
}

/**
 * Real git, and a fake `gh`: `pr create` answers PR #7 on the `--repo`,
 * `pr view` answers `prState.value`. Every call is recorded. The project's
 * origin is a local bare repository, so `remote get-url origin` on `root` is
 * answered as GitHub's `acme/widget` — the runner only opens PRs there.
 */
export const withFakeGh = (git: Exec, root: string) => {
  const calls: GhCall[] = [];
  const prState = { value: 'OPEN' };
  const exec: Exec = async (binary, args, options) => {
    if (
      binary === 'git' &&
      args.join(' ') === `-C ${root} remote get-url origin`
    ) {
      return {
        code: 0,
        stdout: 'git@github.com:acme/widget.git\n',
        stderr: '',
      };
    }
    if (binary !== 'gh') return git(binary, args, options);
    const bodyAt = args.indexOf('--body-file');
    const body =
      bodyAt >= 0 ? await Bun.file(args[bodyAt + 1] ?? '').text() : null;
    calls.push({ args: [...args], body });
    const repo = args[args.indexOf('--repo') + 1];
    const ok = (stdout: string): ExecResult => ({
      code: 0,
      stdout,
      stderr: '',
    });
    if (args[0] === 'pr' && args[1] === 'create') {
      return ok(`https://github.com/${repo}/pull/7\n`);
    }
    if (args[0] === 'pr' && args[1] === 'view') return ok(`${prState.value}\n`);
    return { code: 1, stdout: '', stderr: 'unsupported' };
  };
  return { exec, calls, prState };
};

/**
 * A workspace for skill tests: a source repository standing in for
 * `github.com/acme/skills`, and a project `widget` with a bare origin.
 */
export const skillsWorkspace = async () => {
  const { dir, cleanup } = tempDir();
  const ws = realpathSync(dir);
  const git = isolatedGit(ws);
  const run = async (cwd: string, ...args: string[]) => {
    const result = await git('git', ['-C', cwd, ...args]);
    if (!result || result.code !== 0) {
      throw new Error(`git ${args.join(' ')}: ${result?.stderr}`);
    }
    return result.stdout.trim();
  };
  const write = (root: string, files: Record<string, string>) => {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
  };
  const commitAll = async (root: string, message: string) => {
    await run(root, 'add', '-A');
    await run(root, 'commit', '-q', '-m', message);
    return run(root, 'rev-parse', 'HEAD');
  };

  // The skill source.
  const source = join(ws, 'sources', 'acme-skills');
  mkdirSync(source, { recursive: true });
  await run(source, 'init', '-q', '-b', 'main');
  write(source, {
    'README.md': '# acme skills\n',
    'skills/estimate/SKILL.md':
      '---\nname: estimate\ndescription: Estimates effort.\nargument-hint: <issue>\nallowed-tools: [Read]\n---\nEstimate it.\n',
    'skills/estimate/scripts/size.sh': 'echo 3\n',
    'skills/review/SKILL.md':
      '---\nname: review\ndescription: Reviews code.\n---\nReview it.\n',
  });
  const sourceCommit = await commitAll(source, 'skills');

  // The project, its bare origin and the main checkout.
  const origin = join(ws, 'origin', 'widget.git');
  mkdirSync(origin, { recursive: true });
  await run(origin, 'init', '-q', '--bare', '-b', 'main');
  const root = join(ws, 'widget');
  mkdirSync(root, { recursive: true });
  await run(root, 'init', '-q', '-b', 'main');
  await run(root, 'remote', 'add', 'origin', origin);
  write(root, { 'README.md': '# widget\n', 'src/app.txt': 'v1\n' });
  await commitAll(root, 'init');
  await run(root, 'push', '-q', 'origin', 'main');
  await run(root, 'fetch', '-q', 'origin');
  await run(root, 'remote', 'set-head', 'origin', 'main');

  const project: WatchedProject = { id: 'prj_widget', root };
  const profileDir = join(ws, 'profiles', 'work');
  const codexDir = join(ws, 'profiles', 'codex');
  const profiles: ConfigProfile[] = [
    {
      id: 'claude-work',
      runtime: 'claude',
      env: { CLAUDE_CONFIG_DIR: profileDir },
      args: [],
    },
    {
      id: 'codex-default',
      runtime: 'codex',
      env: { CODEX_HOME: codexDir },
      args: [],
    },
  ];

  const deps = (
    exec: Exec,
    overrides: Partial<SkillsDeps> = {},
  ): SkillsDeps => ({
    exec,
    clock: new FakeClock(Date.parse('2026-10-09T12:00:00.000Z')),
    home: ws,
    profiles: () => profiles,
    watchedProjects: () => [project],
    // `acme/skills` → the local source; any other source names no repository.
    remoteOf: (s) =>
      s === 'acme/skills' ? `file://${source}` : `file://${ws}/missing/${s}`,
    tempRoot: ws,
    shortId: () => 'abc12345',
    ...overrides,
  });

  return {
    ws,
    git,
    run,
    write,
    commitAll,
    source,
    sourceCommit,
    origin,
    root,
    project,
    profiles,
    profileDir,
    codexDir,
    deps,
    cleanup,
  };
};

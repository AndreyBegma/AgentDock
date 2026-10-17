import { afterEach, describe, expect, it } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { createExec, type Exec, withGitConfig } from './detect/exec';
import { GITHUB_GIT_CONFIG, GitAuth, HARDENED_GIT_CONFIG } from './git-auth';
import { tempDir } from './testing/fixtures';

/**
 * #329 D1 against real git: the runner as a service has no SSH agent, so a
 * `git@github.com:` remote is reached over HTTPS with `gh`'s credentials.
 * `gh` is stubbed; git reads the settings exactly as a push would.
 */
let teardown: (() => void)[] = [];
afterEach(() => {
  for (const fn of teardown.reverse()) fn();
  teardown = [];
});

const workspace = async (
  remote: string,
  extraEnv: Record<string, string> = {},
) => {
  const { dir, cleanup } = tempDir();
  teardown.push(cleanup);
  const home = realpathSync(dir);
  // No SSH_AUTH_SOCK, no user or system config: the systemd unit's situation.
  const real = createExec({
    PATH: process.env.PATH,
    HOME: home,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    ...extraEnv,
  });
  const root = join(home, 'widget');
  const init = await real('git', ['init', '-q', root]);
  expect(init?.code).toBe(0);
  await real('git', ['-C', root, 'remote', 'add', 'origin', remote]);
  const gh = { loggedIn: true, probes: [] as string[][] };
  const exec: Exec = async (binary, args, options) => {
    if (binary === 'gh') {
      gh.probes.push([...args]);
      return { code: gh.loggedIn ? 0 : 1, stdout: '', stderr: '' };
    }
    return real(binary, args, options);
  };
  const auth = new GitAuth(exec);
  const git = auth.wrap(exec);
  const out = async (...args: string[]) => {
    const result = await git('git', ['-C', root, ...args]);
    return result?.code === 0 ? result.stdout.trim() : null;
  };
  return { auth, gh, out };
};

describe('GitAuth (#329 D1)', () => {
  it('probes gh for github.com only', async () => {
    const { auth, gh } = await workspace('git@github.com:o/r.git');
    expect(await auth.probe()).toBe('gh');
    expect(gh.probes).toEqual([['auth', 'status', '--hostname', 'github.com']]);
    gh.loggedIn = false;
    expect(await auth.probe()).toBe('native');
    expect(auth.github).toBe('native');
  });

  it('with gh logged in, an SSH remote is pushed to over HTTPS with gh credentials', async () => {
    const { auth, out } = await workspace('git@github.com:o/r.git');
    await auth.probe();
    expect(await out('remote', 'get-url', '--push', 'origin')).toBe(
      'https://github.com/o/r.git',
    );
    expect(await out('ls-remote', '--get-url', 'origin')).toBe(
      'https://github.com/o/r.git',
    );
    // The empty value first resets the helpers inherited for github.com.
    const helpers = await auth.wrap(async (_b, _a, options) => ({
      code: 0,
      stdout: JSON.stringify(options?.gitConfig),
      stderr: '',
    }))('git', ['config']);
    expect(JSON.parse(helpers?.stdout ?? '[]')).toEqual([
      ...HARDENED_GIT_CONFIG,
      ['url.https://github.com/.insteadOf', 'git@github.com:'],
      ['url.https://github.com/.insteadOf', 'ssh://git@github.com/'],
      ['credential.https://github.com.helper', ''],
      ['credential.https://github.com.helper', '!gh auth git-credential'],
    ]);
    expect(
      await out('config', '--get-all', 'credential.https://github.com.helper'),
    ).toBe('!gh auth git-credential');
  });

  it('rewrites the ssh:// form too', async () => {
    const { auth, out } = await workspace('ssh://git@github.com/o/r.git');
    await auth.probe();
    expect(await out('remote', 'get-url', '--push', 'origin')).toBe(
      'https://github.com/o/r.git',
    );
  });

  it('leaves a remote on another host alone', async () => {
    const { auth, out } = await workspace('git@gitlab.example.com:o/r.git');
    await auth.probe();
    expect(await out('remote', 'get-url', '--push', 'origin')).toBe(
      'git@gitlab.example.com:o/r.git',
    );
    expect(
      await out(
        'config',
        '--get-urlmatch',
        'credential.helper',
        'https://gitlab.example.com',
      ),
    ).toBeNull();
  });

  it('with gh not logged in, sets only the hardened GIT_CONFIG_*', async () => {
    const { auth, gh, out } = await workspace('git@github.com:o/r.git');
    gh.loggedIn = false;
    await auth.probe();
    expect(await out('remote', 'get-url', '--push', 'origin')).toBe(
      'git@github.com:o/r.git',
    );
    const calls: unknown[] = [];
    const spy: Exec = async (_binary, _args, options) => {
      calls.push(options);
      return { code: 0, stdout: '', stderr: '' };
    };
    await auth.wrap(spy)('git', ['status'], { timeoutMs: 5 });
    expect(calls).toEqual([{ timeoutMs: 5, gitConfig: HARDENED_GIT_CONFIG }]);
  });

  it('before the first probe it is native', async () => {
    const { auth, out } = await workspace('git@github.com:o/r.git');
    expect(auth.github).toBe('native');
    expect(await out('remote', 'get-url', '--push', 'origin')).toBe(
      'git@github.com:o/r.git',
    );
  });

  it('keeps the settings an inherited GIT_CONFIG_COUNT carries', async () => {
    const { auth, out } = await workspace('git@github.com:o/r.git', {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'user.name',
      GIT_CONFIG_VALUE_0: 'Person',
    });
    await auth.probe();
    expect(await out('config', 'user.name')).toBe('Person');
    expect(await out('remote', 'get-url', '--push', 'origin')).toBe(
      'https://github.com/o/r.git',
    );
  });

  it('passes every other binary as is', async () => {
    const { auth } = await workspace('git@github.com:o/r.git');
    await auth.probe();
    const seen: unknown[] = [];
    const spy: Exec = async (_binary, _args, options) => {
      seen.push(options);
      return { code: 0, stdout: '', stderr: '' };
    };
    await auth.wrap(spy)('gh', ['pr', 'list']);
    await auth.wrap(spy)('tmux', ['-V']);
    expect(seen).toEqual([undefined, undefined]);
  });
});

describe('withGitConfig (#329 D1)', () => {
  it('appends after the inherited entries and adds nothing for none', () => {
    expect(withGitConfig({ A: '1' }, [])).toEqual({ A: '1' });
    expect(
      withGitConfig({ GIT_CONFIG_COUNT: '2' }, GITHUB_GIT_CONFIG.slice(0, 1)),
    ).toEqual({
      GIT_CONFIG_COUNT: '3',
      GIT_CONFIG_KEY_2: 'url.https://github.com/.insteadOf',
      GIT_CONFIG_VALUE_2: 'git@github.com:',
    });
    expect(
      withGitConfig({ GIT_CONFIG_COUNT: 'junk' }, [['a.b', 'c']]),
    ).toMatchObject({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'a.b' });
  });
});

/**
 * C-126: a hook or `core.fsmonitor` planted in a repository's own config must
 * not run in the runner's git, whichever call site makes the call.
 */
describe('GitAuth hardening (C-126)', () => {
  const planted = async () => {
    const { dir, cleanup } = tempDir();
    teardown.push(cleanup);
    const home = realpathSync(dir);
    const real = createExec({
      PATH: process.env.PATH,
      HOME: home,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    });
    const root = join(home, 'repo');
    const marker = join(home, 'marker');
    const script = (name: string) => {
      const path = join(home, name);
      writeFileSync(path, `#!/bin/sh\ntouch ${marker}\n`);
      chmodSync(path, 0o755);
      return path;
    };
    mkdirSync(join(root, 'hooks'), { recursive: true });
    writeFileSync(join(root, 'hooks', 'post-checkout'), '');
    const hook = script('hook.sh');
    const monitor = script('monitor.sh');
    renameSync(hook, join(root, 'hooks', 'post-checkout'));
    const git = new GitAuth(real).wrap(real);
    const run = async (...args: string[]) => {
      const result = await git('git', ['-C', root, ...args]);
      expect(result?.code, result?.stderr).toBe(0);
    };
    await real('git', ['init', '-q', root]);
    await run('commit', '--allow-empty', '-q', '-m', 'init');
    await run('config', 'core.hooksPath', join(root, 'hooks'));
    await run('config', 'core.fsmonitor', monitor);
    return { home, root, marker, run };
  };

  it('does not run a repository post-checkout hook on worktree add or checkout', async () => {
    const { home, marker, run } = await planted();
    await run('worktree', 'add', '-q', '-b', 'card', join(home, 'wt'), 'HEAD');
    await run('-C', join(home, 'wt'), 'checkout', '-q', '-b', 'other');
    expect(existsSync(marker)).toBe(false);
  });

  it('does not run core.fsmonitor on git status', async () => {
    const { marker, run } = await planted();
    await run('status', '--porcelain');
    expect(existsSync(marker)).toBe(false);
  });

  it('adds the hardened settings to git only', async () => {
    const seen: unknown[] = [];
    const spy: Exec = async (_binary, _args, options) => {
      seen.push(options?.gitConfig);
      return { code: 0, stdout: '', stderr: '' };
    };
    await new GitAuth(spy).wrap(spy)('git', ['status']);
    await new GitAuth(spy).wrap(spy)('gh', ['pr', 'list']);
    expect(seen).toEqual([HARDENED_GIT_CONFIG, undefined]);
  });
});

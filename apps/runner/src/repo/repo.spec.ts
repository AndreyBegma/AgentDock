import { afterEach, describe, expect, it, setDefaultTimeout } from 'bun:test';
import {
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import {
  CODE_ASK_ANSWER_MAX,
  type CodeAskArgs,
  codeAskResultSchema,
  commands,
  REPO_READ_CHARS_MAX,
  REPO_READ_LINES_MAX,
  type RepoReadArgs,
  type RepoSearchArgs,
  repoReadArgsSchema,
  repoReadResultSchema,
  repoSearchArgsSchema,
  repoSearchResultSchema,
  type WatchedProject,
} from '@agentdock/shared/protocol';
import type { CaptureSpawn } from '../capture/executor';
import { createDispatcher } from '../commands/dispatcher';
import { CommandFailure } from '../commands/failure';
import { createHandlers } from '../commands/handlers';
import type { ConfigProfile } from '../config';
import type { PolicyConfig } from '../policy/schema';
import { permissivePolicy } from '../policy/testing';
import { isolatedGit } from '../skills/testing';
import { FakeClock } from '../testing/fake-clock';
import { memoryLogger, tempDir } from '../testing/fixtures';
import { REAL_PROCESS_TIMEOUT_MS } from '../testing/projects';
import {
  CodeAsker,
  codeAskArgv,
  codeAskDenyRules,
  outsideCheckoutRules,
} from './ask';
import { createRepoHandlers } from './index';
import { deniedBy, isSecretPath } from './paths';
import { repoRead } from './read';
import { repoSearch } from './search';
import type { RepoDeps } from './types';

setDefaultTimeout(REAL_PROCESS_TIMEOUT_MS * 2);

let teardown: (() => void)[] = [];
afterEach(() => {
  for (const fn of teardown.reverse()) fn();
  teardown = [];
});

const write = (root: string, files: Record<string, string>) => {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
};

/**
 * A checkout with code, secrets (tracked and ignored), a policy-denied
 * directory, a file outside it and symlinks that point out and at a secret.
 */
const setup = async (deny: string[] = []) => {
  const { dir, cleanup } = tempDir();
  teardown.push(cleanup);
  const ws = realpathSync(dir);
  const exec = isolatedGit(ws);
  const root = join(ws, 'widget');
  mkdirSync(root, { recursive: true });
  const git = async (...args: string[]) => {
    const result = await exec('git', ['-C', root, ...args]);
    if (!result || result.code !== 0) throw new Error(result?.stderr);
  };
  await git('init', '-q', '-b', 'main');
  write(ws, { 'outside.txt': 'OUTSIDE_SECRET\n' });
  write(root, {
    '.gitignore': 'dist/\n.env\n',
    'src/billing/invoice.ts':
      'export function computeInvoice(total: number) {\n  return total * 1.2;\n}\n',
    'src/app.ts':
      "import { computeInvoice } from './billing/invoice';\ncomputeInvoice(1);\n",
    'src/big.ts': `${Array.from({ length: 1000 }, (_, i) => `const line${i} = ${i};`).join('\n')}\n`,
    'src/minified.js': `${'x'.repeat(REPO_READ_CHARS_MAX * 2)}\n`,
    '.env': 'API_TOKEN=computeInvoice-secret\n',
    '.env.production': 'API_TOKEN=computeInvoice-prod\n',
    'config/deploy.pem': '-----BEGIN computeInvoice KEY-----\n',
    'config/id_ed25519': 'computeInvoice private key\n',
    'internal/payroll.ts': 'export const computeInvoice = 0;\n',
    'dist/bundle.js': 'computeInvoice()\n',
  });
  await git('add', '-A');
  // `.env.production` is tracked on purpose: tracked secrets are refused too.
  await git('add', '-f', '.env.production');
  await git(
    '-c',
    'user.name=R',
    '-c',
    'user.email=r@example.test',
    'commit',
    '-q',
    '-m',
    'init',
  );
  symlinkSync(join(ws, 'outside.txt'), join(root, 'src', 'escape.ts'));
  symlinkSync(join(root, '.env'), join(root, 'src', 'config.ts'));
  symlinkSync(ws, join(root, 'up'));
  const project: WatchedProject = { id: 'prj_widget', root };
  const policy: PolicyConfig = {
    ...permissivePolicy(),
    code: { deny },
  };
  const deps: RepoDeps = {
    exec,
    watchedProjects: () => [project],
    policy: () => policy,
  };
  const read = (path: string, extra: Partial<RepoReadArgs> = {}) =>
    repoRead(
      repoReadArgsSchema.parse({
        projectId: project.id,
        root,
        path,
        ...extra,
      }),
      deps,
    );
  const search = (query: string, extra: Partial<RepoSearchArgs> = {}) =>
    repoSearch(
      repoSearchArgsSchema.parse({
        projectId: project.id,
        root,
        query,
        ...extra,
      }),
      deps,
    );
  return { ws, root, project, policy, deps, read, search };
};

const failure = async (work: Promise<unknown>) =>
  work.then(
    () => 'resolved',
    (error: unknown) =>
      error instanceof CommandFailure
        ? error.code
        : error instanceof Error
          ? error.message
          : String(error),
  );

describe('secret and deny matching (#622)', () => {
  it('knows env files, keys and credential directories at any depth, in any case', () => {
    for (const path of [
      '.env',
      '.env.local',
      'apps/api/.env.production',
      'certs/server.PEM',
      'deploy/id_rsa',
      'deploy/id_ed25519.pub',
      '.git/config',
      'home/.ssh/known_hosts',
      'ops/credentials.json',
      '.npmrc',
    ]) {
      expect([path, isSecretPath(path)]).toEqual([path, true]);
    }
    for (const path of [
      'src/env.ts',
      'docs/environment.md',
      '.github/workflows/ci.yml',
      'src/keys.ts',
      '.gitignore',
    ]) {
      expect([path, isSecretPath(path)]).toEqual([path, false]);
    }
  });

  it('matches a deny pattern by name at any depth, or as a path from the top', () => {
    expect(deniedBy('a/internal/x.ts', ['internal'])).toBe('internal');
    expect(deniedBy('src/x.secret.ts', ['*.secret.ts'])).toBe('*.secret.ts');
    expect(deniedBy('config/prod/db.yml', ['config/prod'])).toBe('config/prod');
    expect(deniedBy('config/prod/db.yml', ['/config/**'])).toBe('/config/**');
    expect(deniedBy('other/config/prod/db.yml', ['config/prod'])).toBeNull();
    expect(deniedBy('src/app.ts', ['internal', '*.pem'])).toBeNull();
  });
});

describe('repo.read (#622)', () => {
  it('reads a file of the checkout, with its line count', async () => {
    const t = await setup();
    const result = await t.read('src/billing/invoice.ts');
    expect(result).toEqual({
      path: 'src/billing/invoice.ts',
      content:
        'export function computeInvoice(total: number) {\n  return total * 1.2;\n}\n',
      startLine: 1,
      endLine: 3,
      totalLines: 3,
      truncated: false,
    });
    expect(repoReadResultSchema.safeParse(result).success).toBe(true);
    expect(
      (await t.read('./src/../src/app.ts', { startLine: 2 })).content,
    ).toBe('computeInvoice(1);\n');
  });

  it('refuses every path that leaves the checkout', async () => {
    const t = await setup();
    for (const path of [
      '../outside.txt',
      '../../etc/passwd',
      'src/../../outside.txt',
      '..',
      '/etc/passwd',
      `${t.ws}/outside.txt`,
      '..\\outside.txt',
      'src/escape.ts',
      'up/outside.txt',
    ]) {
      expect([path, await failure(t.read(path))]).toEqual([
        path,
        'path_not_allowed',
      ]);
    }
  });

  it('never returns a secret, tracked, ignored or behind a symlink', async () => {
    const t = await setup();
    for (const path of [
      '.env',
      '.env.production',
      'config/deploy.pem',
      'config/id_ed25519',
      '.git/config',
      'src/config.ts',
      'dist/bundle.js',
    ]) {
      expect([path, await failure(t.read(path))]).toEqual([
        path,
        'path_not_allowed',
      ]);
    }
  });

  it('refuses what the runner-local policy denies, naming the rule', async () => {
    const t = await setup(['internal']);
    const error = await t.read('internal/payroll.ts').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CommandFailure);
    expect((error as CommandFailure).code).toBe('policy_refused');
    expect((error as CommandFailure).message).toContain(
      "refused by this runner's policy (code.deny)",
    );
    expect((error as CommandFailure).message).toContain(
      'agentdock-runner policy allow-path internal',
    );
  });

  it('caps a read by lines and by characters', async () => {
    const t = await setup();
    const big = await t.read('src/big.ts');
    expect(big.totalLines).toBe(1000);
    expect(big.endLine).toBe(REPO_READ_LINES_MAX);
    expect(big.truncated).toBe(true);
    expect(big.content.split('\n')).toHaveLength(REPO_READ_LINES_MAX + 1);
    const tail = await t.read('src/big.ts', { startLine: 990 });
    expect(tail).toMatchObject({ endLine: 1000, truncated: false });
    const minified = await t.read('src/minified.js');
    expect(minified.content.length).toBe(REPO_READ_CHARS_MAX);
    expect(minified.truncated).toBe(true);
    expect(repoReadResultSchema.safeParse(minified).success).toBe(true);
  });

  it('answers path_not_found for a missing file and refuses a directory', async () => {
    const t = await setup();
    expect(await failure(t.read('src/nope.ts'))).toBe('path_not_found');
    expect(await failure(t.read('src'))).toBe('path_not_allowed');
  });

  it('refuses a project or root that is not on the watch list', async () => {
    const t = await setup();
    const args = repoReadArgsSchema.parse({
      projectId: t.project.id,
      root: t.ws,
      path: 'outside.txt',
    });
    expect(await failure(repoRead(args, t.deps))).toBe('path_not_allowed');
  });
});

describe('repo.search (#622)', () => {
  it('finds code and withholds every secret, ignored and denied match', async () => {
    const t = await setup(['internal']);
    const result = await t.search('computeInvoice');
    expect(repoSearchResultSchema.safeParse(result).success).toBe(true);
    const paths = result.matches.map((m) => m.path).sort();
    expect([...new Set(paths)]).toEqual([
      'src/app.ts',
      'src/billing/invoice.ts',
    ]);
    expect(result.matches).toContainEqual({
      path: 'src/billing/invoice.ts',
      line: 1,
      text: 'export function computeInvoice(total: number) {',
    });
    // Nothing of `.env`, the keys, `dist/` or `internal/`, nor `outside.txt`.
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(JSON.stringify(result)).not.toContain('KEY');
    expect(JSON.stringify(result)).not.toContain('payroll');
  });

  it('caps the matches and cuts long lines', async () => {
    const t = await setup();
    const result = await t.search('const line', { maxResults: 5 });
    expect(result.matches).toHaveLength(5);
    expect(result.truncated).toBe(true);
    const long = await t.search('xxxx', { path: 'src/minified.js' });
    expect(long.matches[0].text.length).toBeLessThanOrEqual(301);
  });

  it('narrows to a path, which must stay inside the checkout', async () => {
    const t = await setup();
    const result = await t.search('computeInvoice', { path: 'src/billing' });
    expect(result.matches.map((m) => m.path)).toEqual([
      'src/billing/invoice.ts',
    ]);
    expect(await failure(t.search('x', { path: '../' }))).toBe(
      'path_not_allowed',
    );
    expect(await failure(t.search('x', { path: 'up' }))).toBe(
      'path_not_allowed',
    );
    expect(await failure(t.search('x', { path: '.git' }))).toBe(
      'path_not_allowed',
    );
  });

  it('answers no match as an empty result, and a bad regex as invalid_args', async () => {
    const t = await setup();
    expect(await t.search('no-such-text-anywhere')).toEqual({
      matches: [],
      truncated: false,
      withheld: 0,
    });
    expect(await failure(t.search('(', { regex: true }))).toBe('invalid_args');
  });
});

const PROFILES: ConfigProfile[] = [
  {
    id: 'claude-work',
    runtime: 'claude',
    env: { CLAUDE_CONFIG_DIR: '/home/dev/.claude-work' },
    args: [],
  },
  { id: 'codex', runtime: 'codex', env: {}, args: [] },
];

const resultLine = (result: string, isError = false) =>
  `${JSON.stringify({ type: 'result', subtype: isError ? 'error' : 'success', is_error: isError, result })}\n`;

const askSetup = async (stdout: string, deny: string[] = []) => {
  const t = await setup(deny);
  const calls: {
    command: readonly string[];
    cwd: string;
    env: Record<string, string>;
    prompt: string;
  }[] = [];
  const spawn: CaptureSpawn = ({ command, cwd, env, stdinFile }) => {
    calls.push({ command, cwd, env, prompt: readFileSync(stdinFile, 'utf8') });
    return {
      exited: Promise.resolve(0),
      stdout: Promise.resolve(stdout),
      stderr: Promise.resolve(''),
      kill: () => {},
    };
  };
  const asker = new CodeAsker({
    dir: join(t.ws, 'code-ask'),
    env: { PATH: '/usr/bin' },
    clock: new FakeClock(),
    log: memoryLogger().log,
    profiles: () => PROFILES,
    watchedProjects: () => [t.project],
    policy: t.deps.policy,
    otlpPort: () => 4318,
    spawn,
  });
  const args = (extra: Partial<CodeAskArgs> = {}): CodeAskArgs => ({
    projectId: t.project.id,
    root: t.root,
    runId: 'run_1',
    sessionId: '4f7c1a52-9a0b-4f0e-8a51-6f9e0b8c1d2e',
    profileKey: 'claude-work',
    model: 'sonnet',
    question: 'Where is the invoice total computed?',
    ...extra,
  });
  return { ...t, calls, asker, args };
};

describe('code.ask (#622)', () => {
  it('runs one read-only session in the checkout and returns its answer', async () => {
    const t = await askSetup(
      resultLine('In `src/billing/invoice.ts:1`, `computeInvoice`.'),
    );
    const result = await t.asker.ask(t.args());
    expect(result).toEqual({
      answer: 'In `src/billing/invoice.ts:1`, `computeInvoice`.',
      truncated: false,
    });
    expect(codeAskResultSchema.safeParse(result).success).toBe(true);
    const [call] = t.calls;
    expect(call.cwd).toBe(t.root);
    expect(call.prompt).toContain(
      '<question>\nWhere is the invoice total computed?\n</question>',
    );
    expect(call.env.AGENTDOCK_HOOKS).toBe('off');
    expect(call.env.OTEL_RESOURCE_ATTRIBUTES).toContain('agentdock.run=run_1');
  });

  it('cannot write files or run commands: plan mode, read tools only, no MCP, no project settings', () => {
    const argv = codeAskArgv(
      PROFILES[0],
      { model: 'sonnet', sessionId: '4f7c1a52-9a0b-4f0e-8a51-6f9e0b8c1d2e' },
      { ...permissivePolicy(), code: { deny: [] } },
      '/srv/widget',
      () => [],
    );
    const after = (flag: string) => argv[argv.indexOf(flag) + 1];
    expect(after('--permission-mode')).toBe('plan');
    expect(after('--tools')).toBe('Read,Grep,Glob');
    expect(argv).toContain('--strict-mcp-config');
    expect(after('--setting-sources')).toBe('user');
    expect(argv).not.toContain('--dangerously-skip-permissions');
    const disallowed = argv.slice(
      argv.indexOf('--disallowedTools') + 1,
      argv.indexOf('--strict-mcp-config'),
    );
    for (const tool of ['Bash', 'Edit', 'Write', 'NotebookEdit', 'WebFetch']) {
      expect(disallowed).toContain(tool);
    }
  });

  it('refuses secrets and policy-denied paths by permission rules', () => {
    const rules = codeAskDenyRules({
      ...permissivePolicy(),
      code: { deny: ['internal', 'config/prod'] },
    });
    for (const rule of [
      'Read(**/.env*)',
      'Read(**/*.pem)',
      'Read(**/.git/**)',
      'Read(**/internal)',
      'Read(**/internal/**)',
      'Read(./config/prod/**)',
      'Read(~/.ssh/**)',
    ]) {
      expect(rules).toContain(rule);
    }
  });

  it('refuses every read beside the checkout, at each level up to /', () => {
    const tree: Record<string, string[]> = {
      '/': ['etc', 'home', 'srv', 'tmp'],
      '/srv': ['widget', 'other-repo', 'odd(name)', 'star*'],
    };
    const rules = outsideCheckoutRules('/srv/widget', (dir) => tree[dir] ?? []);
    expect(rules).toEqual([
      'Read(//etc)',
      'Read(//etc/**)',
      'Read(//home)',
      'Read(//home/**)',
      'Read(//tmp)',
      'Read(//tmp/**)',
      'Read(//srv/other-repo)',
      'Read(//srv/other-repo/**)',
      'Read(//srv/star\\*)',
      'Read(//srv/star\\*/**)',
    ]);
    expect(rules.join(' ')).not.toContain('widget');
  });

  it('cuts a long answer, and fails on no answer or a codex profile', async () => {
    const long = await askSetup(
      resultLine('a'.repeat(CODE_ASK_ANSWER_MAX + 50)),
    );
    const cut = await long.asker.ask(long.args());
    expect(cut.truncated).toBe(true);
    expect(cut.answer.length).toBe(CODE_ASK_ANSWER_MAX + 1);
    const none = await askSetup(resultLine('', true));
    expect(await failure(none.asker.ask(none.args()))).toBe(
      'the code agent gave no answer',
    );
    expect(
      await failure(none.asker.ask(none.args({ profileKey: 'codex' }))),
    ).toBe('unsupported_runtime');
  });

  it('refuses a root that is not the watched checkout', async () => {
    const t = await askSetup(resultLine('x'));
    expect(await failure(t.asker.ask(t.args({ root: t.ws })))).toBe(
      'path_not_allowed',
    );
    expect(t.calls).toHaveLength(0);
  });
});

describe('the runner advertises the code commands (#622)', () => {
  it('serves repo.search, repo.read and code.ask, behind the policy roots', async () => {
    const t = await askSetup(resultLine('src/app.ts:1'));
    const handlers = createHandlers({
      clock: new FakeClock(),
      runnerVersion: 'test',
      host: { hostname: 'h', os: 'linux', arch: 'x64' } as never,
      detectCapabilities: async () => ({}) as never,
      exec: t.deps.exec,
      watchedProjects: t.deps.watchedProjects,
      profiles: () => PROFILES,
      policy: t.deps.policy,
      repo: createRepoHandlers(t.deps, t.asker),
    });
    for (const name of ['repo.search', 'repo.read', 'code.ask'] as const) {
      expect(Object.keys(handlers)).toContain(name);
      expect(commands[name].minRole).toBe('viewer');
    }
    const outside = createDispatcher({
      handlers,
      disabledCommands: [],
      policy: () => ({ ...t.policy, allowedRoots: ['/nowhere'] }),
      realpath: (path) => path,
      clock: new FakeClock(),
      log: memoryLogger().log,
    });
    const refused = await outside({
      id: 'cmd_1',
      name: 'repo.read',
      args: { projectId: t.project.id, root: t.root, path: 'src/app.ts' },
    } as never);
    expect(JSON.stringify(refused)).toContain('policy_refused');
  });
});

import { afterEach, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DocsPublishSpecsArgs } from '@agentdock/shared/protocol';
import { CommandFailure } from '../commands/failure';
import type { Exec } from '../detect/exec';
import { skillsWorkspace, withFakeGh } from '../skills/testing';
import { REAL_PROCESS_TIMEOUT_MS } from '../testing/projects';
import { createDocsHandlers, docsPrState, publishDocsSpecs } from './index';

setDefaultTimeout(REAL_PROCESS_TIMEOUT_MS * 2);

let teardown: (() => void)[] = [];
afterEach(() => {
  for (const fn of teardown.reverse()) fn();
  teardown = [];
});

/** The widget project and, beside it, `widget-documentation` with a bare origin. */
const setup = async () => {
  const f = await skillsWorkspace();
  teardown.push(f.cleanup);
  const docsOrigin = join(f.ws, 'origin', 'widget-documentation.git');
  mkdirSync(docsOrigin, { recursive: true });
  await f.run(docsOrigin, 'init', '-q', '--bare', '-b', 'trunk');
  const docs = join(f.ws, 'widget-documentation');
  mkdirSync(docs, { recursive: true });
  await f.run(docs, 'init', '-q', '-b', 'trunk');
  await f.run(docs, 'remote', 'add', 'origin', docsOrigin);
  f.write(docs, { 'README.md': '# docs\n', 'prs/.keep': '' });
  await f.commitAll(docs, 'init');
  await f.run(docs, 'push', '-q', 'origin', 'trunk');
  await f.run(docs, 'fetch', '-q', 'origin');
  await f.run(docs, 'remote', 'set-head', 'origin', 'trunk');

  const gh = withFakeGh(f.git, f.root);
  // The docs clone's origin is a local bare repository; GitHub names it.
  const exec: Exec = async (binary, a, options) => {
    if (
      binary === 'git' &&
      a.join(' ') === `-C ${docs} remote get-url origin`
    ) {
      return {
        code: 0,
        stdout: 'git@github.com:acme/widget-documentation.git\n',
        stderr: '',
      };
    }
    return gh.exec(binary, a, options);
  };
  const args = (
    overrides: Partial<DocsPublishSpecsArgs> = {},
  ): DocsPublishSpecsArgs => ({
    projectId: f.project.id,
    root: f.root,
    docsRoot: docs,
    specDir: 'prs',
    branch: 'docs/card-abc12345',
    files: [{ path: 'prs/41-export.md', content: '# Export\n' }],
    title: 'docs(specs): C-3 Export',
    body: 'Spec of acme/widget#41.\n',
    ...overrides,
  });
  return { f, gh, exec, docs, docsOrigin, args };
};

const codeOf = async (work: Promise<unknown>) => {
  const error = await work.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(CommandFailure);
  return (error as CommandFailure).code;
};

describe('docs.publish_specs (#379)', () => {
  it('opens a pull request in the docs repository, into its default branch', async () => {
    const { f, gh, exec, docs, docsOrigin, args } = await setup();
    expect(await publishDocsSpecs(args(), f.deps(exec))).toEqual({
      repo: 'acme/widget-documentation',
      prNumber: 7,
      prUrl: 'https://github.com/acme/widget-documentation/pull/7',
    });
    const branch = 'docs/card-abc12345';
    const origin = (...a: string[]) => f.run(docsOrigin, ...a);
    expect(
      (await origin('diff', '--name-only', `trunk..${branch}`)).split('\n'),
    ).toEqual(['prs/41-export.md']);
    expect(await origin('log', '-1', '--format=%B', branch)).toBe(
      'docs(specs): C-3 Export',
    );
    const create = gh.calls.find(
      (c) => c.args[0] === 'pr' && c.args[1] === 'create',
    );
    expect(create?.args.slice(0, 8)).toEqual([
      'pr',
      'create',
      '--repo',
      'acme/widget-documentation',
      '--base',
      'trunk',
      '--head',
      branch,
    ]);
    expect(create?.body).toBe('Spec of acme/widget#41.\n');
    // The clone's checkout is untouched; its docs worktree is gone.
    expect(await f.run(docs, 'branch', '--show-current')).toBe('trunk');
    expect(existsSync(join(docs, 'prs', '41-export.md'))).toBe(false);
    expect(await f.run(docs, 'worktree', 'list', '--porcelain')).not.toContain(
      'plan-docs',
    );
    // The code repository got nothing.
    expect(await f.run(f.root, 'branch', '--list', branch)).toBe('');
  });

  it('refuses a docs root that is a folder inside a repository', async () => {
    const { f, exec, docs, args } = await setup();
    expect(
      await codeOf(
        publishDocsSpecs(args({ docsRoot: join(docs, 'prs') }), f.deps(exec)),
      ),
    ).toBe('not_a_repository');
  });

  it('refuses a docs root that does not exist', async () => {
    const { f, exec, args } = await setup();
    expect(
      await codeOf(
        publishDocsSpecs(
          args({ docsRoot: join(f.ws, 'missing') }),
          f.deps(exec),
        ),
      ),
    ).toBe('path_not_found');
  });

  it('refuses a docs clone without a GitHub remote', async () => {
    const { f, gh, args } = await setup();
    expect(await codeOf(publishDocsSpecs(args(), f.deps(gh.exec)))).toBe(
      'not_a_repository',
    );
  });

  it('refuses a project the runner does not watch', async () => {
    const { f, exec, args } = await setup();
    expect(
      await codeOf(
        publishDocsSpecs(args({ root: join(f.ws, 'elsewhere') }), f.deps(exec)),
      ),
    ).toBe('path_not_allowed');
  });
});

describe('docs.pr_state (#379)', () => {
  it('reads the docs pull request state from GitHub', async () => {
    const { f, gh, exec, docs } = await setup();
    const target = { projectId: f.project.id, root: f.root, docsRoot: docs };
    expect(await docsPrState({ ...target, pr: 7 }, f.deps(exec))).toEqual({
      state: 'open',
    });
    gh.prState.value = 'MERGED';
    const handlers = createDocsHandlers(f.deps(exec));
    expect(await handlers['docs.pr_state']({ ...target, pr: 7 })).toEqual({
      state: 'merged',
    });
    const view = gh.calls.find((c) => c.args[1] === 'view');
    expect(view?.args.slice(0, 5)).toEqual([
      'pr',
      'view',
      '7',
      '--repo',
      'acme/widget-documentation',
    ]);
  });
});

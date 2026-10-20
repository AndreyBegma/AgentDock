import { afterEach, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { PlanPublishSpecsArgs } from '@nautelle/shared/protocol';
import { CommandFailure } from '../commands/failure';
import type { Exec } from '../detect/exec';
import { skillsWorkspace, withFakeGh } from '../skills/testing';
import { REAL_PROCESS_TIMEOUT_MS } from '../testing/projects';
import { publishSpecs } from './publish-specs';

setDefaultTimeout(REAL_PROCESS_TIMEOUT_MS * 2);

let teardown: (() => void)[] = [];
afterEach(() => {
  for (const fn of teardown.reverse()) fn();
  teardown = [];
});

const setup = async () => {
  const f = await skillsWorkspace();
  teardown.push(f.cleanup);
  // A project hook that would add an attribution trailer: the runner must not run it.
  const hook = join(f.root, '.git', 'hooks', 'commit-msg');
  await Bun.write(
    hook,
    '#!/bin/sh\nprintf "\\nCo-Authored-By: Claude <noreply@anthropic.com>\\nClaude-Session: x\\n" >> "$1"\n',
  );
  chmodSync(hook, 0o755);
  const gh = withFakeGh(f.git, f.root);
  const args = (
    overrides: Partial<PlanPublishSpecsArgs> = {},
  ): PlanPublishSpecsArgs => ({
    planId: 'plan_1',
    projectId: f.project.id,
    root: f.root,
    base: 'main',
    specDir: 'docs/specs',
    branch: 'docs/plan-abc12345',
    files: [
      { path: 'docs/specs/41-export.md', content: '# Export\n' },
      { path: 'docs/specs/42-import.md', content: '# Import\n\nÜnïcode.\n' },
    ],
    title: 'docs(specs): plan Export and Import',
    body: 'Specs for plan plan_1.\n',
    ...overrides,
  });
  return { f, gh, args };
};

const codeOf = async (work: Promise<unknown>) => {
  const error = await work.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(CommandFailure);
  return (error as CommandFailure).code;
};

describe('plan.publish_specs (D10)', () => {
  it('opens one pull request with exactly the given files and a commit without trailers', async () => {
    const { f, gh, args } = await setup();
    expect(await publishSpecs(args(), f.deps(gh.exec))).toEqual({
      prNumber: 7,
      prUrl: 'https://github.com/acme/widget/pull/7',
    });

    const branch = 'docs/plan-abc12345';
    const origin = (...a: string[]) => f.run(f.origin, ...a);
    expect(await origin('log', '-1', '--format=%B', branch)).toBe(
      'docs(specs): plan Export and Import',
    );
    const message = await origin(
      'log',
      '-1',
      '--format=%B%n%(trailers)',
      branch,
    );
    expect(message).not.toContain('Co-Authored-By');
    expect(message).not.toContain('Claude-Session');
    expect(
      (await origin('diff', '--name-only', `main..${branch}`)).split('\n'),
    ).toEqual(['docs/specs/41-export.md', 'docs/specs/42-import.md']);
    expect(await origin('show', `${branch}:docs/specs/42-import.md`)).toBe(
      '# Import\n\nÜnïcode.',
    );
    // One commit on top of the base.
    expect(await origin('rev-list', '--count', `main..${branch}`)).toBe('1');

    const create = gh.calls.find(
      (c) => c.args[0] === 'pr' && c.args[1] === 'create',
    );
    expect(create?.args).toEqual([
      'pr',
      'create',
      '--repo',
      'acme/widget',
      '--base',
      'main',
      '--head',
      branch,
      '--title',
      'docs(specs): plan Export and Import',
      '--body-file',
      expect.any(String),
    ]);
    expect(create?.body).toBe('Specs for plan plan_1.\n');

    // The docs worktree and the local branch are gone; the pushed branch stays.
    expect(
      await f.run(f.root, 'worktree', 'list', '--porcelain'),
    ).not.toContain('plan-docs');
    expect(await f.run(f.root, 'branch', '--list', branch)).toBe('');
    expect(existsSync(join(f.ws, '.wt-widget-plan-docs-abc12345'))).toBe(false);
  });

  it('publishes approved .html designs next to the spec, byte for byte', async () => {
    const { f, gh, args } = await setup();
    const html =
      '<!doctype html>\n<html><body><h1>Export — ünï</h1></body></html>\n';
    await publishSpecs(
      args({
        files: [
          { path: 'docs/specs/41-export.md', content: '# Export\n' },
          { path: 'docs/specs/41-export/design/1.html', content: html },
          { path: 'docs/specs/41-export/design/2.html', content: html },
        ],
      }),
      f.deps(gh.exec),
    );
    const branch = 'docs/plan-abc12345';
    expect(
      (await f.run(f.origin, 'diff', '--name-only', `main..${branch}`)).split(
        '\n',
      ),
    ).toEqual([
      'docs/specs/41-export.md',
      'docs/specs/41-export/design/1.html',
      'docs/specs/41-export/design/2.html',
    ]);
    expect(
      await f.run(
        f.origin,
        'show',
        `${branch}:docs/specs/41-export/design/1.html`,
      ),
    ).toBe(html.trimEnd());
  });

  it('refuses a design file whose directory is a symlink out of specDir', async () => {
    const { f, gh, args } = await setup();
    const outside = join(f.ws, 'outside');
    mkdirSync(outside);
    mkdirSync(join(f.root, 'docs/specs/41-export'), { recursive: true });
    symlinkSync(outside, join(f.root, 'docs/specs/41-export/design'));
    await f.commitAll(f.root, 'design link');
    await f.run(f.root, 'push', '-q', 'origin', 'main');

    expect(
      await codeOf(
        publishSpecs(
          args({
            files: [
              {
                path: 'docs/specs/41-export/design/1.html',
                content: '<html></html>',
              },
            ],
          }),
          f.deps(gh.exec),
        ),
      ),
    ).toBe('path_not_allowed');
    expect(existsSync(join(outside, '1.html'))).toBe(false);
  });

  it('answers the open pull request a previous attempt opened, without pushing again', async () => {
    const { f, gh, args } = await setup();
    const calls: string[][] = [];
    const exec: Exec = async (binary, a, options) => {
      calls.push([binary, ...a]);
      if (binary === 'gh' && a[0] === 'pr' && a[1] === 'view') {
        return {
          code: 0,
          stdout:
            '{"number":9,"url":"https://github.com/acme/widget/pull/9","state":"OPEN"}\n',
          stderr: '',
        };
      }
      return gh.exec(binary, a, options);
    };
    expect(await publishSpecs(args(), f.deps(exec))).toEqual({
      prNumber: 9,
      prUrl: 'https://github.com/acme/widget/pull/9',
    });
    expect(calls.some((c) => c.includes('push'))).toBe(false);
  });

  it('refuses a specDir that resolves outside the worktree, and cleans up', async () => {
    const { f, gh, args } = await setup();
    const outside = join(f.ws, 'outside');
    mkdirSync(outside);
    mkdirSync(join(f.root, 'docs'));
    symlinkSync(outside, join(f.root, 'docs', 'specs'));
    await f.commitAll(f.root, 'specs link');
    await f.run(f.root, 'push', '-q', 'origin', 'main');

    expect(await codeOf(publishSpecs(args(), f.deps(gh.exec)))).toBe(
      'path_not_allowed',
    );
    expect(existsSync(join(outside, '41-export.md'))).toBe(false);
    expect(
      await f.run(f.root, 'worktree', 'list', '--porcelain'),
    ).not.toContain('plan-docs');
    expect(gh.calls.some((c) => c.args[1] === 'create')).toBe(false);
  });

  it('refuses a project the runner does not watch', async () => {
    const { f, gh, args } = await setup();
    expect(
      await codeOf(
        publishSpecs(args({ root: join(f.ws, 'elsewhere') }), f.deps(gh.exec)),
      ),
    ).toBe('path_not_allowed');
  });
});

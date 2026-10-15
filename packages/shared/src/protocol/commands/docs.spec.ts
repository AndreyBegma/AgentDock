import { describe, expect, it } from 'bun:test';
import { RUNNER_FEATURE_COMMANDS } from '../capabilities';
import { commands } from '../commands';
import {
  cardDocsBranch,
  docsPrStateArgsSchema,
  docsPublishSpecsArgsSchema,
} from './docs';

const valid = {
  projectId: 'prj_1',
  root: '/work/app',
  docsRoot: '/work/app-documentation',
  specDir: 'prs',
  branch: 'docs/card-abc12345',
  files: [{ path: 'prs/41-export.md', content: '# Export\n' }],
  title: 'docs(specs): C-3 Export',
  body: 'Spec of acme/app#41.',
};

describe('docs commands (#379)', () => {
  it('are in the allowlist and the docsRepo feature', () => {
    expect(commands['docs.publish_specs'].minRole).toBe('operator');
    expect(commands['docs.pr_state'].minRole).toBe('operator');
    expect(RUNNER_FEATURE_COMMANDS.docsRepo).toEqual(['docs.publish_specs']);
  });

  it('accepts a card or plan branch and .md specs under specDir', () => {
    expect(docsPublishSpecsArgsSchema.safeParse(valid).success).toBe(true);
    expect(
      docsPublishSpecsArgsSchema.safeParse({
        ...valid,
        branch: 'docs/plan-abc12345',
      }).success,
    ).toBe(true);
    expect(cardDocsBranch('abc12345')).toBe('docs/card-abc12345');
  });

  it.each([
    ['a relative docs root', { docsRoot: 'app-documentation' }],
    ['the code repository as docs root', { docsRoot: '/work/app/' }],
    ['a specDir with ..', { specDir: '../prs' }],
    ['another branch', { branch: 'main' }],
    [
      'a file outside specDir',
      { files: [{ path: 'docs/41-export.md', content: 'x' }] },
    ],
    [
      'a design file',
      { files: [{ path: 'prs/41-export/design/1.html', content: 'x' }] },
    ],
    [
      'duplicate paths',
      {
        files: [
          { path: 'prs/41.md', content: 'x' },
          { path: 'prs/41.md', content: 'y' },
        ],
      },
    ],
  ])('refuses %s', (_name, override) => {
    expect(
      docsPublishSpecsArgsSchema.safeParse({ ...valid, ...override }).success,
    ).toBe(false);
  });

  it('takes a docs pull request number for docs.pr_state', () => {
    const target = {
      projectId: 'prj_1',
      root: '/work/app',
      docsRoot: '/work/app-documentation',
    };
    expect(docsPrStateArgsSchema.safeParse({ ...target, pr: 3 }).success).toBe(
      true,
    );
    expect(docsPrStateArgsSchema.safeParse({ ...target, pr: 0 }).success).toBe(
      false,
    );
  });
});

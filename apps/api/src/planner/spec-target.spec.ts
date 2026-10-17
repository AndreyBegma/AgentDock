import { resolveSpecTarget, type SpecTargetProject } from './spec-target';

const project = (
  overrides: Partial<SpecTargetProject> = {},
): SpecTargetProject => ({
  rootPath: '/work/denitsa-app',
  codeSentinelConfig: null,
  docsSource: null,
  ...overrides,
});

const docs = (
  source: Partial<NonNullable<SpecTargetProject['docsSource']>>,
): SpecTargetProject['docsSource'] => ({
  kind: 'none',
  localPath: null,
  repo: null,
  specDir: null,
  ...source,
});

describe('resolveSpecTarget (#379)', () => {
  it('puts specs of in-repo docs under the docs folder of the code repository', () => {
    expect(
      resolveSpecTarget(
        project({
          docsSource: docs({
            kind: 'in_repo',
            localPath: '/work/denitsa-app/docs',
            specDir: 'specs',
          }),
        }),
      ),
    ).toEqual({ kind: 'code_repo', specDir: 'docs/specs' });
  });

  it('takes the root itself as an in-repo docs root', () => {
    expect(
      resolveSpecTarget(
        project({
          docsSource: docs({
            kind: 'in_repo',
            localPath: '/work/denitsa-app/',
            specDir: 'prs',
          }),
        }),
      ),
    ).toEqual({ kind: 'code_repo', specDir: 'prs' });
  });

  it('writes to a sibling docs repository through its local clone', () => {
    expect(
      resolveSpecTarget(
        project({
          // The Spec folder wins over a specDir outside the repository.
          codeSentinelConfig: {
            orchestrator: { specDir: '../denitsa-documentation/prs' },
          },
          docsSource: docs({
            kind: 'sibling_repo',
            localPath: '/work/denitsa-documentation',
            repo: 'AndreyBegma/denitsa-documentation',
            specDir: 'prs',
          }),
        }),
      ),
    ).toEqual({
      kind: 'docs_repo',
      docsRoot: '/work/denitsa-documentation',
      repo: 'AndreyBegma/denitsa-documentation',
      specDir: 'prs',
    });
  });

  it('writes to a remote docs repository that has a local clone', () => {
    expect(
      resolveSpecTarget(
        project({
          docsSource: docs({
            kind: 'remote_repo',
            localPath: '/clones/denitsa-documentation',
            repo: 'AndreyBegma/denitsa-documentation',
            specDir: 'specs/cards',
          }),
        }),
      ),
    ).toMatchObject({
      kind: 'docs_repo',
      docsRoot: '/clones/denitsa-documentation',
      specDir: 'specs/cards',
    });
  });

  it('refuses a remote docs repository without a local clone', () => {
    expect(
      resolveSpecTarget(
        project({
          codeSentinelConfig: { orchestrator: { specDir: 'docs/specs' } },
          docsSource: docs({
            kind: 'remote_repo',
            repo: 'AndreyBegma/denitsa-documentation',
            specDir: 'prs',
          }),
        }),
      ),
    ).toEqual({
      kind: 'no_docs_clone',
      repo: 'AndreyBegma/denitsa-documentation',
    });
  });

  it('falls back to a repository-relative specDir without a Spec folder', () => {
    const config = { orchestrator: { specDir: 'docs/specs' } };
    expect(resolveSpecTarget(project({ codeSentinelConfig: config }))).toEqual({
      kind: 'code_repo',
      specDir: 'docs/specs',
    });
    expect(
      resolveSpecTarget(
        project({
          codeSentinelConfig: config,
          docsSource: docs({
            kind: 'sibling_repo',
            localPath: '/work/denitsa-documentation',
          }),
        }),
      ),
    ).toEqual({ kind: 'code_repo', specDir: 'docs/specs' });
  });

  it('has no target without a Spec folder or a repository-relative specDir', () => {
    expect(resolveSpecTarget(project())).toEqual({ kind: 'no_spec_dir' });
    expect(
      resolveSpecTarget(
        project({
          codeSentinelConfig: {
            orchestrator: { specDir: '../denitsa-documentation/prs' },
          },
          docsSource: docs({
            kind: 'sibling_repo',
            localPath: '/work/denitsa-documentation',
          }),
        }),
      ),
    ).toEqual({ kind: 'no_spec_dir' });
  });

  it('ignores a Spec folder that is not a relative path', () => {
    expect(
      resolveSpecTarget(
        project({
          docsSource: docs({
            kind: 'sibling_repo',
            localPath: '/work/denitsa-documentation',
            specDir: '../elsewhere',
          }),
        }),
      ),
    ).toEqual({ kind: 'no_spec_dir' });
  });
});

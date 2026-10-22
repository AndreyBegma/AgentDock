import { inspectedDefaultBranch } from './projects.service';

describe('inspectedDefaultBranch (C-148)', () => {
  it('takes the default branch the runner reports, even next to another base', () => {
    expect(
      inspectedDefaultBranch({
        baseBranch: 'develop',
        baseSource: 'config',
        defaultBranch: 'trunk',
      }),
    ).toBe('trunk');
    expect(
      inspectedDefaultBranch({
        baseBranch: 'main',
        baseSource: 'default',
        defaultBranch: null,
      }),
    ).toBeNull();
  });

  it('falls back to a base read from origin/HEAD or gh for an older runner', () => {
    expect(
      inspectedDefaultBranch({ baseBranch: 'trunk', baseSource: 'gh' }),
    ).toBe('trunk');
    expect(
      inspectedDefaultBranch({ baseBranch: 'main', baseSource: 'origin_head' }),
    ).toBe('main');
    expect(
      inspectedDefaultBranch({ baseBranch: 'main', baseSource: 'default' }),
    ).toBeNull();
    expect(
      inspectedDefaultBranch({ baseBranch: 'develop', baseSource: 'config' }),
    ).toBeNull();
  });
});

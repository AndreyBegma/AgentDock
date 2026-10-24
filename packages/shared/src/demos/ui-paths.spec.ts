import { describe, expect, it } from 'bun:test';
import { DEMO_UI_PATHS_DEFAULT } from './contracts';
import { demoUiPathMatches, touchesDemoUiPaths } from './ui-paths';

describe('demo UI paths (C-370)', () => {
  it('matches a trailing ** below its directory only', () => {
    expect(demoUiPathMatches('apps/web/**', 'apps/web/app/page.ts')).toBe(true);
    expect(demoUiPathMatches('apps/web/**', 'apps/web/x')).toBe(true);
    expect(demoUiPathMatches('apps/web/**', 'apps/webby/x')).toBe(false);
    expect(demoUiPathMatches('apps/web/**', 'apps/api/web/x')).toBe(false);
  });

  it('matches **/ as zero or more whole segments', () => {
    expect(demoUiPathMatches('**/*.tsx', 'a.tsx')).toBe(true);
    expect(demoUiPathMatches('**/*.tsx', 'apps/web/ui/button.tsx')).toBe(true);
    expect(demoUiPathMatches('**/*.tsx', 'apps/web/ui/button.ts')).toBe(false);
    expect(demoUiPathMatches('src/**/x.ts', 'src/x.ts')).toBe(true);
    expect(demoUiPathMatches('src/**/x.ts', 'src/a/b/x.ts')).toBe(true);
  });

  it('keeps * and ? within one segment', () => {
    expect(demoUiPathMatches('*.css', 'site.css')).toBe(true);
    expect(demoUiPathMatches('*.css', 'apps/site.css')).toBe(false);
    expect(demoUiPathMatches('a?c.ts', 'abc.ts')).toBe(true);
    expect(demoUiPathMatches('a?c.ts', 'a/c.ts')).toBe(false);
  });

  it('takes regex characters literally', () => {
    expect(
      demoUiPathMatches('app/(home)/page.tsx', 'app/(home)/page.tsx'),
    ).toBe(true);
    expect(demoUiPathMatches('a.b', 'axb')).toBe(false);
    expect(demoUiPathMatches('[id].tsx', '[id].tsx')).toBe(true);
  });

  it('decides a pull request by any file and any glob', () => {
    const globs = [...DEMO_UI_PATHS_DEFAULT];
    expect(touchesDemoUiPaths(['apps/api/src/a.ts'], globs)).toBe(false);
    expect(
      touchesDemoUiPaths(['apps/api/src/a.ts', 'packages/ui/x.css'], globs),
    ).toBe(true);
    expect(touchesDemoUiPaths(['apps/web/next.config.ts'], globs)).toBe(true);
    expect(touchesDemoUiPaths([], globs)).toBe(false);
    expect(touchesDemoUiPaths(['a.tsx'], [])).toBe(false);
    expect(touchesDemoUiPaths(['a.tsx'], ['  '])).toBe(false);
  });
});

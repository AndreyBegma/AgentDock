import { describe, expect, it } from 'bun:test';
import { correlateCwd } from './correlate';

const ACME = { id: 'prj_acme', root: '/srv/dev/acme' };
const APP = { id: 'prj_app', root: '/srv/dev/app' };
const APP_WEB = { id: 'prj_app_web', root: '/srv/dev/app-web' };

describe('correlateCwd (D6)', () => {
  it('links a session inside .wt-<repo>-i42 to that project and slot i42', () => {
    expect(correlateCwd('/srv/dev/.wt-acme-i42', [ACME])).toEqual({
      projectId: 'prj_acme',
      slot: 'i42',
    });
    expect(correlateCwd('/srv/dev/.wt-acme-i42/apps/api', [ACME])).toEqual({
      projectId: 'prj_acme',
      slot: 'i42',
    });
  });

  it('links a session at or below a project root to the project, without a slot', () => {
    expect(correlateCwd('/srv/dev/acme', [ACME])).toEqual({
      projectId: 'prj_acme',
    });
    expect(correlateCwd('/srv/dev/acme/apps/web/', [ACME])).toEqual({
      projectId: 'prj_acme',
    });
  });

  it('gives a session in an unrelated directory no project', () => {
    expect(correlateCwd('/srv/dev/other', [ACME])).toEqual({});
    expect(correlateCwd('/srv/dev/acme-old', [ACME])).toEqual({});
    expect(correlateCwd('/srv/dev/.wt-other-i42', [ACME])).toEqual({});
    expect(correlateCwd('/srv/dev/.wt-acme-', [ACME])).toEqual({});
    expect(correlateCwd('/srv/dev/acme', [])).toEqual({});
  });

  it('takes the deepest root when projects nest', () => {
    const inner = { id: 'prj_inner', root: '/srv/dev/acme/packages/inner' };
    expect(
      correlateCwd('/srv/dev/acme/packages/inner/src', [ACME, inner]),
    ).toEqual({ projectId: 'prj_inner' });
  });

  it('prefers the longer repository name for a worktree', () => {
    expect(correlateCwd('/srv/dev/.wt-app-web-i1', [APP, APP_WEB])).toEqual({
      projectId: 'prj_app_web',
      slot: 'i1',
    });
    expect(correlateCwd('/srv/dev/.wt-app-i1', [APP, APP_WEB])).toEqual({
      projectId: 'prj_app',
      slot: 'i1',
    });
  });
});

import { projectMatches, resolveProject } from './webhook-dispatcher';

const PROJECTS = [
  { id: 'p1', runnerId: 'r1', rootPath: '/srv/a', repo: 'acme/a' },
  { id: 'p2', runnerId: 'r1', rootPath: '/srv/b', repo: 'acme/b' },
  { id: 'p3', runnerId: 'r1', rootPath: '/srv/b2', repo: 'acme/b' },
  { id: 'p4', runnerId: 'r2', rootPath: '/srv/a', repo: 'acme/a' },
];

describe('resolveProject', () => {
  it('matches the runner and root first', () => {
    expect(
      resolveProject(
        { runnerId: 'r2', projectRoot: '/srv/a', projectRepo: null },
        PROJECTS,
      )?.id,
    ).toBe('p4');
  });

  it('falls back to a repo only when it is unique on the runner', () => {
    expect(
      resolveProject(
        { runnerId: 'r1', projectRoot: null, projectRepo: 'acme/a' },
        PROJECTS,
      )?.id,
    ).toBe('p1');
    expect(
      resolveProject(
        { runnerId: 'r1', projectRoot: null, projectRepo: 'acme/b' },
        PROJECTS,
      ),
    ).toBeNull();
  });

  it('finds nothing for an event without a project', () => {
    expect(
      resolveProject(
        { runnerId: 'r1', projectRoot: null, projectRepo: null },
        PROJECTS,
      ),
    ).toBeNull();
  });
});

describe('projectMatches (spec 26 D11)', () => {
  it('takes every project, and the project-less events, when empty', () => {
    expect(projectMatches({ projectIds: [] }, 'p1')).toBe(true);
    expect(projectMatches({ projectIds: [] }, null)).toBe(true);
  });

  it('takes only the listed projects otherwise', () => {
    expect(projectMatches({ projectIds: ['p1'] }, 'p1')).toBe(true);
    expect(projectMatches({ projectIds: ['p1'] }, 'p2')).toBe(false);
    expect(projectMatches({ projectIds: ['p1'] }, null)).toBe(false);
  });
});

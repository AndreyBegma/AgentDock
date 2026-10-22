import {
  isForwardable,
  projectMatches,
  resolveProject,
} from './webhook-dispatcher';

describe('isForwardable (L-16)', () => {
  it.each([
    'schedule.disabled',
    'schedule.failed',
  ])('forwards %s only when the API emitted it', (type) => {
    expect(isForwardable({ type, source: 'api' })).toBe(true);
    expect(isForwardable({ type, source: 'runner' })).toBe(false);
    expect(isForwardable({ type, source: 'scraped' })).toBe(false);
  });

  it('keeps runner-originated types as they are', () => {
    expect(isForwardable({ type: 'slot.dispatched', source: 'runner' })).toBe(
      true,
    );
    expect(isForwardable({ type: 'pr.opened', source: 'scraped' })).toBe(true);
  });

  it('never forwards webhook.test or an unknown type', () => {
    expect(isForwardable({ type: 'webhook.test', source: 'api' })).toBe(false);
    expect(isForwardable({ type: 'llm.request', source: 'runner' })).toBe(
      false,
    );
  });
});

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

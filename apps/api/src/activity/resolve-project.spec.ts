import { resolveProject } from './activity-projector.service';

const projects = [
  { id: 'a', runnerId: 'r1', rootPath: '/srv/dev/widget', repo: 'acme/widget' },
  { id: 'b', runnerId: 'r1', rootPath: '/srv/dev/gadget', repo: 'acme/gadget' },
  {
    id: 'c',
    runnerId: 'r1',
    rootPath: '/srv/dev/gadget-2',
    repo: 'acme/gadget',
  },
  { id: 'd', runnerId: 'r2', rootPath: '/srv/dev/widget', repo: 'acme/widget' },
];

const event = (
  runnerId: string,
  projectRoot: string | null,
  projectRepo: string | null,
) => ({ runnerId, projectRoot, projectRepo });

describe('resolveProject (spec 21 D4)', () => {
  it('resolves by the runner and the project root', () => {
    expect(
      resolveProject(projects, event('r1', '/srv/dev/widget', 'acme/widget')),
    ).toBe('a');
    expect(
      resolveProject(projects, event('r2', '/srv/dev/widget', 'acme/widget')),
    ).toBe('d');
  });

  it('does not fall back to the repo when the root is unknown', () => {
    expect(
      resolveProject(
        projects,
        event('r1', '/srv/dev/elsewhere', 'acme/widget'),
      ),
    ).toBeNull();
  });

  it('uses the repo only when one project of the runner has it', () => {
    expect(resolveProject(projects, event('r1', null, 'acme/widget'))).toBe(
      'a',
    );
    expect(
      resolveProject(projects, event('r1', null, 'acme/gadget')),
    ).toBeNull();
    expect(
      resolveProject(projects, event('r3', null, 'acme/widget')),
    ).toBeNull();
  });

  it('gives no project to a runner-level event', () => {
    expect(resolveProject(projects, event('r1', null, null))).toBeNull();
  });
});

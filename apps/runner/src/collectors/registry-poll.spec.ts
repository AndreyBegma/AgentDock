import { describe, expect, it } from 'bun:test';
import type { GitHubAppHealth } from '@agentdock/shared/protocol';
import { memoryLogger } from '../testing/fixtures';
import { type Collector, CollectorRegistry } from './registry';

const A = { id: 'prj_a', root: '/dev/a' };
const B = { id: 'prj_b', root: '/dev/b' };

/**
 * A collector that answers `pollNow` for the names it owns and records every
 * call, start, stop and health it sees.
 */
const fakeCollector =
  (name: string, owns: string[], journal: string[]) => (): Collector => {
    let project = '';
    return {
      name,
      start: (p) => {
        project = p.id;
        journal.push(`start ${name} ${p.id}`);
      },
      stop: () => {
        journal.push(`stop ${name} ${project}`);
      },
      setGithubApp: (health: GitHubAppHealth | undefined) => {
        journal.push(`health ${name} ${health ?? 'none'}`);
      },
      pollNow: async (targets) => {
        const mine = targets.filter((t) => owns.includes(t));
        if (mine.length > 0) journal.push(`poll ${name} ${project} ${mine}`);
        return mine;
      },
    };
  };

const setup = () => {
  const journal: string[] = [];
  const registry = new CollectorRegistry({
    factories: [
      fakeCollector('issues', ['issues'], journal),
      fakeCollector('fleet', ['prs', 'worktrees'], journal),
      // No `pollNow`: never asked, never reported.
      () => ({ name: 'events', start: () => {}, stop: () => {} }),
    ],
    emit: () => {},
    log: memoryLogger().log,
  });
  return { registry, journal };
};

const polls = (journal: string[]) =>
  journal.filter((l) => l.startsWith('poll'));

describe('CollectorRegistry.pollNow (spec 27 D13)', () => {
  it('polls exactly the named collectors of that project and restarts nothing', async () => {
    const { registry, journal } = setup();
    await registry.setProjects([A, B]);
    journal.length = 0;

    expect(await registry.pollNow('prj_a', ['issues'])).toEqual(['issues']);
    expect(journal).toEqual(['poll issues prj_a issues']);

    journal.length = 0;
    expect(await registry.pollNow('prj_b', ['prs', 'worktrees'])).toEqual([
      'prs',
      'worktrees',
    ]);
    expect(journal).toEqual(['poll fleet prj_b prs,worktrees']);
  });

  it('reports only what was polled, and nothing for an unknown project', async () => {
    const { registry, journal } = setup();
    await registry.setProjects([A]);
    journal.length = 0;
    expect(await registry.pollNow('prj_zzz', ['issues', 'prs'])).toEqual([]);
    expect(polls(journal)).toEqual([]);
    expect(await registry.pollNow('prj_a', ['issues', 'prs'])).toEqual([
      'issues',
      'prs',
    ]);
  });

  it('survives a collector whose poll throws', async () => {
    const journal: string[] = [];
    const { log, lines } = memoryLogger();
    const registry = new CollectorRegistry({
      factories: [
        () => ({
          name: 'bad',
          start: () => {},
          stop: () => {},
          pollNow: async () => {
            throw new Error('boom');
          },
        }),
        fakeCollector('issues', ['issues'], journal),
      ],
      emit: () => {},
      log,
    });
    await registry.setProjects([A]);
    expect(await registry.pollNow('prj_a', ['issues'])).toEqual(['issues']);
    expect(lines.some((l) => l.includes('collector: poll failed'))).toBe(true);
  });
});

describe('CollectorRegistry GitHub App health (spec 27 D12)', () => {
  it('hands the health to a collector at creation', async () => {
    const { registry, journal } = setup();
    await registry.setProjects([{ ...A, githubApp: 'healthy' }]);
    expect(journal).toContain('health issues healthy');
  });

  it('applies a health change without restarting anything', async () => {
    const { registry, journal } = setup();
    await registry.setProjects([A]);
    journal.length = 0;

    await registry.setProjects([{ ...A, githubApp: 'healthy' }]);
    await registry.setProjects([{ ...A, githubApp: 'healthy' }]);
    await registry.setProjects([A]);
    expect(journal).toEqual([
      'health issues healthy',
      'health fleet healthy',
      'health issues none',
      'health fleet none',
    ]);
    expect(registry.projects).toEqual([A]);
  });
});

import { describe, expect, it } from 'bun:test';
import type { WatchedProject } from '@agentdock/shared/protocol';
import { CollectorRegistry } from '../collectors';
import { memoryLogger } from '../testing/fixtures';
import { WatchList } from './watch-list';

const A = { id: 'prj_a', root: '/dev/a' };
const B = { id: 'prj_b', root: '/dev/b' };

const setup = (initial: WatchedProject[] = []) => {
  const started: string[] = [];
  const persisted: WatchedProject[][] = [];
  const { log } = memoryLogger();
  const registry = new CollectorRegistry({
    factories: [
      () => ({
        name: 'fake',
        start: (p) => {
          started.push(p.id);
        },
        stop: () => {},
      }),
    ],
    emit: () => {},
    log,
  });
  const list = new WatchList({
    initial,
    registry,
    persist: (projects) => {
      persisted.push(projects);
    },
    log,
  });
  return { list, registry, started, persisted };
};

describe('WatchList', () => {
  it('starts collectors from the cached list before the server speaks', async () => {
    const { list, started, persisted } = setup([A]);
    await list.start();
    expect(started).toEqual(['prj_a']);
    expect(persisted).toEqual([]);
  });

  it('follows the server list and caches it only when it changed', async () => {
    const { list, registry, persisted } = setup([A]);
    await list.start();
    await list.apply([A]);
    expect(persisted).toEqual([]);
    await list.apply([A, B]);
    expect(persisted).toEqual([[A, B]]);
    expect(list.current).toEqual([A, B]);
    expect(registry.projects).toEqual([A, B]);
  });

  it('passes the App health to the registry but never caches it (spec 27 D12)', async () => {
    const { list, registry, persisted } = setup([A]);
    await list.start();
    await list.apply([{ ...A, githubApp: 'healthy' }, B]);
    expect(persisted).toEqual([[A, B]]);
    expect(registry.projects).toEqual([{ ...A, githubApp: 'healthy' }, B]);

    // A health flip alone is applied, and is not a change to the cache.
    await list.apply([A, B]);
    expect(persisted).toEqual([[A, B]]);
    expect(registry.projects).toEqual([A, B]);
  });

  it('keeps applying the list when the cache cannot be written', async () => {
    const { log, lines } = memoryLogger();
    const registry = new CollectorRegistry({
      factories: [],
      emit: () => {},
      log,
    });
    const list = new WatchList({
      initial: [],
      registry,
      persist: () => {
        throw new Error('read-only');
      },
      log,
    });
    await list.apply([A]);
    expect(list.current).toEqual([A]);
    expect(lines.join('\n')).toContain('cannot cache the watch list');
  });
});

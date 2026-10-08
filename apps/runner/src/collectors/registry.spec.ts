import { describe, expect, it } from 'bun:test';
import type { Exec } from '../detect/exec';
import { memoryLogger, testEvent } from '../testing/fixtures';
import {
  type Collector,
  type CollectorContext,
  type CollectorFactory,
  CollectorRegistry,
  DEFAULT_FLEET_SETTINGS,
  type Emit,
  type WatchedProject,
} from './registry';

/** A collector that records its lifecycle in a shared journal. */
const fakeCollector = (name: string, journal: string[]) => (): Collector => {
  let project: WatchedProject | null = null;
  return {
    name,
    start: (p, emit) => {
      project = p;
      journal.push(`start ${name} ${p.id} ${p.root}`);
      emit(testEvent(1));
    },
    stop: () => {
      journal.push(`stop ${name} ${project?.id}`);
    },
  };
};

const setup = () => {
  const journal: string[] = [];
  const emitted: unknown[] = [];
  const emit: Emit = (event) => emitted.push(event);
  const registry = new CollectorRegistry({
    factories: [fakeCollector('a', journal), fakeCollector('b', journal)],
    emit,
    log: memoryLogger().log,
  });
  return { registry, journal, emitted };
};

const A = { id: 'prj_a', root: '/dev/a' };
const B = { id: 'prj_b', root: '/dev/b' };

describe('CollectorRegistry', () => {
  it('starts every collector once per watched project and hands it emit', async () => {
    const { registry, journal, emitted } = setup();
    await registry.setProjects([A, B]);
    expect(journal).toEqual([
      'start a prj_a /dev/a',
      'start b prj_a /dev/a',
      'start a prj_b /dev/b',
      'start b prj_b /dev/b',
    ]);
    expect(emitted).toHaveLength(4);
    expect(registry.projects).toEqual([A, B]);
  });

  it('does not restart a project that stays on the list', async () => {
    const { registry, journal } = setup();
    await registry.setProjects([A]);
    journal.length = 0;
    await registry.setProjects([A]);
    await registry.setProjects([{ ...A }]);
    expect(journal).toEqual([]);
  });

  it('stops the collectors of a project removed from the list', async () => {
    const { registry, journal } = setup();
    await registry.setProjects([A, B]);
    journal.length = 0;
    await registry.setProjects([B]);
    expect(journal).toEqual(['stop a prj_a', 'stop b prj_a']);
    expect(registry.projects).toEqual([B]);
  });

  it('restarts a project whose root changed', async () => {
    const { registry, journal } = setup();
    await registry.setProjects([A]);
    journal.length = 0;
    await registry.setProjects([{ id: 'prj_a', root: '/dev/a2' }]);
    expect(journal).toEqual([
      'stop a prj_a',
      'stop b prj_a',
      'start a prj_a /dev/a2',
      'start b prj_a /dev/a2',
    ]);
  });

  it('serializes overlapping updates', async () => {
    const { registry, journal } = setup();
    await Promise.all([
      registry.setProjects([A]),
      registry.setProjects([]),
      registry.setProjects([A]),
    ]);
    expect(journal).toEqual([
      'start a prj_a /dev/a',
      'start b prj_a /dev/a',
      'stop a prj_a',
      'stop b prj_a',
      'start a prj_a /dev/a',
      'start b prj_a /dev/a',
    ]);
  });

  it('hands every factory the context, with safe defaults', async () => {
    const seen: CollectorContext[] = [];
    const record: CollectorFactory = (context) => {
      seen.push(context);
      return { name: 'ctx', start: () => {}, stop: () => {} };
    };
    const { log } = memoryLogger();
    const exec: Exec = async () => ({ code: 0, stdout: '', stderr: '' });
    await new CollectorRegistry({
      factories: [record],
      emit: () => {},
      log,
      context: { exec, fleet: { pollSeconds: 30, prPollSeconds: 90 } },
    }).setProjects([A]);
    expect(seen[0]).toMatchObject({
      exec,
      log,
      fleet: { pollSeconds: 30, prPollSeconds: 90 },
    });

    await new CollectorRegistry({
      factories: [record],
      emit: () => {},
      log,
    }).setProjects([A]);
    expect(seen[1].fleet).toEqual(DEFAULT_FLEET_SETTINGS);
    expect(await seen[1].exec('tmux', ['-V'])).toBeNull();
  });

  it('keeps the others running when one collector fails to start', async () => {
    const journal: string[] = [];
    const { log, lines } = memoryLogger();
    const registry = new CollectorRegistry({
      factories: [
        () => ({
          name: 'broken',
          start: () => {
            throw new Error('no tmux');
          },
          stop: () => {
            journal.push('stop broken');
          },
        }),
        fakeCollector('a', journal),
      ],
      emit: () => {},
      log,
    });
    await registry.setProjects([A]);
    await registry.stop();
    expect(journal).toEqual(['start a prj_a /dev/a', 'stop a prj_a']);
    expect(lines.join('\n')).toContain('collector: start failed');
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  appendFileSync,
  mkdirSync,
  renameSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { UnsequencedEvent } from '@agentdock/shared/protocol';
import { FakeClock } from '../../testing/fake-clock';
import { memoryLogger, tempDir } from '../../testing/fixtures';
import { DEFAULT_FLEET_SETTINGS } from '../registry';
import {
  EVENTS_FILE,
  EventsCollector,
  forgetOffsetStores,
  STATE_FILE,
} from './events';
import { readNewLines } from './tail';

/** A line as plugin `emit.py` writes it (EVENTS.md). */
const line = (
  type: string,
  data: Record<string, unknown>,
  extra: Record<string, unknown> = {},
  v = 1,
): string =>
  JSON.stringify({
    v,
    eid: `eid-${type}-${JSON.stringify(extra)}`,
    ts: '2026-10-08T21:07:12.345Z',
    type,
    source: 'code-sentinel',
    project: { repo: null, root: '/elsewhere' },
    ...extra,
    data,
  });

const dispatched = (slot: string, issue: number) =>
  line(
    'slot.dispatched',
    {
      model: 'sonnet',
      brief: `/srv/widget/.wt-${slot}/.orchestrator-brief.md`,
      worktree: `/srv/widget/.wt-${slot}`,
      branch: `feat/${issue}`,
    },
    { slot, issue },
  );

const checkpoint = (slot: string, issue: number) =>
  line(
    'slot.checkpoint',
    { checkpoint: 'picked_up', heading: 'picked up', summary: 'ok' },
    { slot, issue },
  );

const STATE = {
  v: 1,
  updatedAt: '2026-10-08T21:00:00.000Z',
  slots: {
    'i42-api': {
      issue: 42,
      model: 'opus',
      status: 'running',
      dispatchedAt: '2026-10-08T20:00:00.000Z',
    },
  },
};

describe('EventsCollector', () => {
  let root: string;
  let cleanup: () => void;
  let board: string;
  let offsetsFile: string;
  let clock: FakeClock;
  let emitted: UnsequencedEvent[];
  let started: EventsCollector[];

  beforeEach(() => {
    const temp = tempDir();
    root = join(temp.dir, 'widget');
    cleanup = temp.cleanup;
    board = join(root, '.git', 'cs-orchestrator');
    offsetsFile = join(temp.dir, 'state', 'events-offsets.json');
    mkdirSync(board, { recursive: true });
    clock = new FakeClock();
    emitted = [];
    started = [];
    forgetOffsetStores();
  });
  afterEach(() => {
    for (const collector of started) collector.stop();
    forgetOffsetStores();
    cleanup();
  });

  const start = async (): Promise<EventsCollector> => {
    const collector = new EventsCollector(
      {
        // No git: the board directory falls back to `<root>/.git/cs-orchestrator`.
        exec: async () => null,
        clock,
        log: memoryLogger().log,
        fleet: DEFAULT_FLEET_SETTINGS,
      },
      { offsetsFile, watchFiles: false },
    );
    started.push(collector);
    await collector.start({ id: 'prj_1', root }, (e) => emitted.push(e));
    return collector;
  };
  const events = join.bind(null, '');
  const eventsPath = () => join(board, EVENTS_FILE);
  const append = (...lines: string[]) =>
    appendFileSync(eventsPath(), `${lines.join('\n')}\n`);
  const poll = () => clock.advance(5_000);
  const types = () => emitted.map((e) => e.type);
  void events;

  it('emits nothing for a project without events.jsonl or state.json', async () => {
    await start();
    poll();
    expect(emitted).toEqual([]);
  });

  it('applies lines within one poll of each append, with the plugin source and project', async () => {
    await start();
    append(dispatched('i42-api', 42));
    poll();
    expect(types()).toEqual(['slot.dispatched']);
    expect(emitted[0]).toMatchObject({
      source: 'code-sentinel',
      slot: 'i42-api',
      issue: 42,
      project: { root },
    });
    append(checkpoint('i42-api', 42));
    poll();
    expect(types()).toEqual(['slot.dispatched', 'slot.checkpoint']);
    poll();
    expect(emitted).toHaveLength(2);
  });

  it('switches on without a restart when the file appears later', async () => {
    await start();
    poll();
    expect(emitted).toEqual([]);
    writeFileSync(eventsPath(), `${dispatched('i42-api', 42)}\n`);
    poll();
    expect(types()).toEqual(['slot.dispatched']);
  });

  it('leaves a line without its newline until it is complete', async () => {
    await start();
    const text = dispatched('i42-api', 42);
    appendFileSync(eventsPath(), text.slice(0, 20));
    poll();
    expect(emitted).toEqual([]);
    appendFileSync(eventsPath(), `${text.slice(20)}\n`);
    poll();
    expect(types()).toEqual(['slot.dispatched']);
  });

  it('resumes from the persisted offset after a restart: nothing twice, nothing missed', async () => {
    const first = await start();
    append(dispatched('i42-api', 42));
    poll();
    expect(emitted).toHaveLength(1);
    first.stop();
    forgetOffsetStores();

    append(checkpoint('i42-api', 42));
    await start();
    expect(types()).toEqual(['slot.dispatched', 'slot.checkpoint']);
    poll();
    expect(emitted).toHaveLength(2);
  });

  it('re-reads from 0 when the file is truncated', async () => {
    await start();
    append(dispatched('i42-api', 42), checkpoint('i42-api', 42));
    poll();
    expect(emitted).toHaveLength(2);
    truncateSync(eventsPath(), 0);
    append(dispatched('i43-web', 43));
    poll();
    expect(types()).toEqual([
      'slot.dispatched',
      'slot.checkpoint',
      'slot.dispatched',
    ]);
    expect(emitted[2].slot).toBe('i43-web');
  });

  it('re-reads from 0 when the file is replaced (new inode), even if longer', async () => {
    await start();
    append(dispatched('i42-api', 42));
    poll();
    const replacement = join(board, 'events.new');
    writeFileSync(
      replacement,
      `${[dispatched('i42-api', 42), checkpoint('i42-api', 42), dispatched('i43-web', 43)].join('\n')}\n`,
    );
    renameSync(replacement, eventsPath());
    poll();
    // The API dedupes by pluginEventId: the first line goes out again.
    expect(emitted.map((e) => e.slot)).toEqual([
      'i42-api',
      'i42-api',
      'i42-api',
      'i43-web',
    ]);
  });

  it('reports a malformed line and a v: 99 line as events.unparsed and goes on', async () => {
    await start();
    append(
      '{not json',
      line('slot.dispatched', {}, { slot: 'i1-x' }, 99),
      dispatched('i42-api', 42),
    );
    poll();
    expect(types()).toEqual([
      'events.unparsed',
      'events.unparsed',
      'slot.dispatched',
    ]);
    expect(emitted[0].data).toMatchObject({
      file: eventsPath(),
      line: '{not json',
      offset: 0,
      reason: 'malformed JSON',
    });
    expect(emitted[1].data).toMatchObject({
      reason: expect.stringContaining('99'),
    });
    expect(emitted[2].source).toBe('code-sentinel');
  });

  it('sends a snapshot of state.json on start and again only when it changes', async () => {
    writeFileSync(join(board, STATE_FILE), JSON.stringify(STATE));
    await start();
    expect(types()).toEqual(['orchestrator.snapshot']);
    expect(emitted[0]).toMatchObject({
      source: 'code-sentinel',
      ts: STATE.updatedAt,
      data: { state: { slots: { 'i42-api': { model: 'opus' } } } },
    });
    poll();
    expect(emitted).toHaveLength(1);
    writeFileSync(
      join(board, STATE_FILE),
      JSON.stringify({ ...STATE, updatedAt: '2026-10-08T22:00:00.000Z' }),
    );
    poll();
    expect(types()).toEqual(['orchestrator.snapshot', 'orchestrator.snapshot']);
  });

  it('reports a state.json that fails the schema once, and keeps tailing', async () => {
    writeFileSync(join(board, STATE_FILE), JSON.stringify({ v: 2 }));
    await start();
    poll();
    poll();
    expect(types()).toEqual(['events.unparsed']);
    expect(emitted[0].data).toMatchObject({
      file: join(board, STATE_FILE),
    });
    append(dispatched('i42-api', 42));
    poll();
    expect(types()).toEqual(['events.unparsed', 'slot.dispatched']);
  });

  it('survives the file disappearing', async () => {
    await start();
    append(dispatched('i42-api', 42));
    poll();
    rmSync(eventsPath());
    poll();
    append(checkpoint('i42-api', 42));
    poll();
    expect(types()).toEqual(['slot.dispatched', 'slot.checkpoint']);
  });
});

describe('readNewLines', () => {
  let dir: string;
  let cleanup: () => void;
  beforeEach(() => {
    const temp = tempDir();
    dir = temp.dir;
    cleanup = temp.cleanup;
  });
  afterEach(() => cleanup());

  it('counts bytes, not characters, and skips blank lines and CRs', () => {
    const path = join(dir, 'e.jsonl');
    writeFileSync(path, 'é\r\n\nb\npartial');
    const read = readNewLines(path, undefined);
    expect(read?.lines).toEqual([
      { text: 'é', offset: 0 },
      { text: 'b', offset: 5 },
    ]);
    expect(read?.state.offset).toBe(7);
  });

  it('is null for a missing file', () => {
    expect(readNewLines(join(dir, 'none'), undefined)).toBeNull();
  });
});

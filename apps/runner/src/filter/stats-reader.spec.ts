import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FILTER_STATS_MAX_ROWS,
  type FilterStatRow,
  filterStatsDataSchema,
  type PrefixPart,
} from '@nautelle/shared';
import {
  eventsMessageSchema,
  PREFIX_MEASURED_EVENT,
  PREFIX_OVERLAY_STALE_EVENT,
  prefixMeasuredDataSchema,
  type UnsequencedEvent,
} from '@nautelle/shared/protocol';
import { createLogger } from '../log';
import {
  PREFIX_MEASURED_FILE,
  PREFIX_MEASURED_SENT_FILE,
} from '../prefix/record';
import { FILTER_RUN_FILE, FILTER_STATS_FILE } from './env';
import {
  FILTER_STATS_OFFSET_FILE,
  FilterStatsReader,
  findStatsFiles,
  type RunIdentity,
  readIdentity,
  readNewLines,
} from './stats-reader';

const row = (
  id: string,
  runKind: FilterStatRow['runKind'] = 'card',
): FilterStatRow => ({
  id,
  runId: runKind === 'orchestrator' ? null : 'r1',
  runKind,
  filter: 'js/jest',
  rawBytes: 1000,
  keptBytes: 100,
  bypassed: false,
  passedThrough: false,
  at: '2026-10-16T12:00:00.000Z',
});

const line = (projectId: string, r: FilterStatRow) =>
  `${JSON.stringify({ projectId, row: r })}\n`;

/** The row ids of one `filter.stats` event. */
const ids = (event: UnsequencedEvent | undefined): string[] =>
  (event?.data as { rows: FilterStatRow[] } | undefined)?.rows.map(
    (r) => r.id,
  ) ?? [];

describe('filter stats reader (#445 amendment 5)', () => {
  let root: string;
  let events: UnsequencedEvent[];
  let warnings: string[];
  let reader: FilterStatsReader;

  const runDir = (...parts: string[]) => {
    const dir = join(root, ...parts);
    mkdirSync(dir, { recursive: true });
    return dir;
  };

  /** A run dir as a launch leaves it: with its identity (DR-05). */
  const launched = (identity: RunIdentity, ...parts: string[]): string => {
    const dir = runDir(...parts);
    writeFileSync(join(dir, FILTER_RUN_FILE), JSON.stringify(identity));
    return join(dir, FILTER_STATS_FILE);
  };
  const cardOf = (projectId: string): RunIdentity => ({
    projectId,
    runId: 'r1',
    runKind: 'card',
  });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'stats-'));
    events = [];
    warnings = [];
    reader = new FilterStatsReader({
      roots: () => [
        join(root, 'cards'),
        join(root, 'orchestrator'),
        join(root, 'missing'),
      ],
      resolve: async (ids) =>
        new Map(
          ids
            .filter((id) => id !== 'gone')
            .map((id) => [id, { repo: `acme/${id}`, root: `/srv/${id}` }]),
        ),
      emit: (event) => events.push(event),
      log: createLogger({
        level: 'warn',
        write: (text) => warnings.push(text),
        now: () => new Date(0),
      }),
      now: () => new Date('2026-10-16T12:00:05.000Z'),
    });
  });
  afterEach(() => {
    reader.stop();
    rmSync(root, { recursive: true, force: true });
  });

  it('finds stats files one to three levels down, not in raw dirs', () => {
    const a = runDir('cards', 'c1');
    const b = runDir('cards', 'c2', 'round-1');
    // A card's round: `<cards>/<card>/rounds/<run>`.
    const round = runDir('cards', 'c5', 'rounds', 'run_1');
    const raw = runDir('cards', 'c3', 'raw');
    const deep = runDir('cards', 'c4', 'x', 'y', 'z');
    for (const dir of [a, b, round, raw, deep]) {
      writeFileSync(join(dir, FILTER_STATS_FILE), '');
    }
    writeFileSync(join(root, 'cards', FILTER_STATS_FILE), '');
    const found = findStatsFiles([join(root, 'cards'), join(root, 'nope')]);
    expect(found.sort()).toEqual(
      [a, b, round].map((d) => join(d, FILTER_STATS_FILE)).sort(),
    );
  });

  it('sends the rows as filter.stats events per project, then only new rows', async () => {
    const card = launched(cardOf('a'), 'cards', 'c1');
    const other = launched(cardOf('b'), 'cards', 'c2', 'round-1');
    const orch = launched(
      { projectId: 'b', runId: null, runKind: 'orchestrator' },
      'orchestrator',
      'acme__b',
    );
    writeFileSync(card, line('a', row('r1')));
    writeFileSync(other, line('b', row('r2')));
    writeFileSync(orch, line('b', row('r3', 'orchestrator')));

    await reader.poll();

    expect(events).toHaveLength(3);
    for (const event of events) {
      expect(event).toMatchObject({
        v: 1,
        ts: '2026-10-16T12:00:05.000Z',
        type: 'filter.stats',
        source: 'runner',
      });
      expect(filterStatsDataSchema.safeParse(event.data).success).toBe(true);
    }
    // What goes on the wire parses as an `events` message.
    expect(
      eventsMessageSchema.safeParse({
        type: 'events',
        events: events.map((e, i) => ({ ...e, seq: i + 1 })),
      }).success,
    ).toBe(true);
    const byRepo = Object.fromEntries(
      events.map((e) => [
        `${e.project?.repo}:${(e.data as { rows: FilterStatRow[] }).rows.map((r) => r.id).join(',')}`,
        true,
      ]),
    );
    expect(Object.keys(byRepo).sort()).toEqual([
      'acme/a:r1',
      'acme/b:r2',
      'acme/b:r3',
    ]);

    // A second pass sends nothing; an appended row goes alone.
    await reader.poll();
    expect(events).toHaveLength(3);
    appendFileSync(card, line('a', row('r4')));
    await reader.poll();
    expect(events).toHaveLength(4);
    expect(ids(events[3])).toEqual(['r4']);
    const offset = join(root, 'cards', 'c1', FILTER_STATS_OFFSET_FILE);
    expect(readFileSync(offset, 'utf8').trim()).toBe(
      String(readFileSync(card).byteLength),
    );
  });

  it('waits for a line that is still being written', async () => {
    const file = launched(cardOf('a'), 'cards', 'c1');
    const full = line('a', row('r1'));
    writeFileSync(file, full.slice(0, 20));
    await reader.poll();
    expect(events).toEqual([]);
    writeFileSync(file, full);
    await reader.poll();
    expect(events).toHaveLength(1);
  });

  it(`splits a big file into batches of ${FILTER_STATS_MAX_ROWS}`, async () => {
    const file = launched(cardOf('a'), 'cards', 'c1');
    writeFileSync(
      file,
      Array.from({ length: FILTER_STATS_MAX_ROWS + 5 }, (_, i) =>
        line('a', row(`r${i}`)),
      ).join(''),
    );
    await reader.poll();
    expect(events.map((e) => ids(e).length)).toEqual([
      FILTER_STATS_MAX_ROWS,
      5,
    ]);
  });

  it('skips malformed rows and projects it no longer watches, and moves on', async () => {
    const file = launched(cardOf('a'), 'cards', 'c1');
    writeFileSync(
      file,
      `not json\n${JSON.stringify({ projectId: 'a', row: { ...row('x'), keptBytes: 5000 } })}\n${line('a', row('r2'))}`,
    );
    const gone = launched(cardOf('gone'), 'cards', 'c2');
    writeFileSync(gone, line('gone', row('r1')));
    await reader.poll();
    expect(events).toHaveLength(1);
    expect(ids(events[0])).toEqual(['r2']);
    expect(warnings.join('')).toContain('malformed');
    await reader.poll();
    expect(events).toHaveLength(1);
  });

  it('takes the project and run from the run dir, never from a row (DR-05)', async () => {
    const file = launched(cardOf('a'), 'cards', 'c1');
    writeFileSync(
      file,
      [
        // Another project's id, another run, another kind: all foreign.
        line('b', row('forged-project')),
        line('a', { ...row('forged-run'), runId: 'r9' }),
        line('a', { ...row('forged-kind', 'skill'), runId: 'r1' }),
        line('a', row('own')),
      ].join(''),
    );
    await reader.poll();
    expect(events).toHaveLength(1);
    expect(events[0]?.project?.repo).toBe('acme/a');
    expect(ids(events[0])).toEqual(['own']);
    expect(warnings.join('')).toContain('foreign');
  });

  it('sends nothing from a dir without a valid identity', async () => {
    const bare = join(runDir('cards', 'c1'), FILTER_STATS_FILE);
    writeFileSync(bare, line('a', row('r1')));
    const odd = launched(cardOf(''), 'cards', 'c2');
    writeFileSync(odd, line('', row('r2')));
    await reader.poll();
    expect(events).toEqual([]);
    expect(readIdentity(bare)).toBeNull();
    expect(readIdentity(odd)).toBeNull();
  });

  describe('the launch prefix record (#751 B1, B10)', () => {
    const part: PrefixPart = {
      kind: 'claude_md',
      name: 'CLAUDE.md',
      path: 'CLAUDE.md',
      origin: 'repo',
      bytes: 8,
      estTokens: 2,
      sha256: 'a'.repeat(64),
    };
    const record = (runId = 'r1') => ({
      measured: { runId, launchKind: 'card', parts: [part] },
      stale: [{ runId, overlayId: 'ov_1', sha256: 'b'.repeat(64) }],
    });
    const recorded = (data: unknown, projectId = 'a'): string => {
      const dir = join(root, 'cards', 'c1', 'rounds', 'r1');
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, FILTER_RUN_FILE),
        JSON.stringify(cardOf(projectId)),
      );
      writeFileSync(join(dir, PREFIX_MEASURED_FILE), JSON.stringify(data));
      return dir;
    };

    it('sends prefix.measured and each stale overlay once, with the run dir’s project', async () => {
      const dir = recorded(record());
      await reader.poll();
      await reader.poll();
      expect(events.map((e) => e.type)).toEqual([
        PREFIX_MEASURED_EVENT,
        PREFIX_OVERLAY_STALE_EVENT,
      ]);
      expect(events[0]?.project).toEqual({ repo: 'acme/a', root: '/srv/a' });
      expect(prefixMeasuredDataSchema.parse(events[0]?.data).parts).toEqual([
        part,
      ]);
      expect(events[1]?.data).toEqual(record().stale[0]);
      expect(existsSync(join(dir, PREFIX_MEASURED_SENT_FILE))).toBe(true);
      expect(
        eventsMessageSchema.safeParse({
          type: 'events',
          events: events.map((e, i) => ({ ...e, seq: i + 1 })),
        }).success,
      ).toBe(true);
    });

    it('drops a record of another run, and a malformed one', async () => {
      recorded(record('r2'));
      await reader.poll();
      expect(events).toEqual([]);
      expect(warnings.join('')).toContain('prefix record');
    });
  });

  it('sends a /cs-eco batch with its session id, a run batch without (#748)', async () => {
    const eco = join(root, 'eco');
    const dir = join(eco, 'sessions', 'sess-1');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, FILTER_STATS_FILE),
      line('a', { ...row('e1', 'manual'), runId: null }),
    );
    const card = launched(cardOf('a'), 'cards', 'c1');
    writeFileSync(card, line('a', row('r1')));
    const ecoReader = new FilterStatsReader({
      roots: () => [join(root, 'cards')],
      eco: {
        dir: join(eco, 'sessions'),
        projects: () => [{ id: 'a', root: '/srv/a' }],
        sessionCwd: () => '/srv/a',
      },
      resolve: async (ids) =>
        new Map(
          ids.map((id) => [id, { repo: `acme/${id}`, root: `/srv/${id}` }]),
        ),
      emit: (event) => events.push(event),
      log: createLogger({
        level: 'warn',
        write: (text) => warnings.push(text),
        now: () => new Date(0),
      }),
      now: () => new Date('2026-10-16T12:00:05.000Z'),
    });
    try {
      await ecoReader.poll();
    } finally {
      ecoReader.stop();
    }
    const data = (id: string) =>
      events.find((e) => ids(e).includes(id))?.data as
        | { session?: string }
        | undefined;
    expect(data('e1')?.session).toBe('sess-1');
    expect(filterStatsDataSchema.safeParse(data('e1')).success).toBe(true);
    expect(data('r1')).toBeDefined();
    expect(data('r1')).not.toHaveProperty('session');
  });

  it('starts a file over when it was replaced by a shorter one', () => {
    const file = join(runDir('cards', 'c1'), FILTER_STATS_FILE);
    writeFileSync(file, 'a\nb\n');
    expect(readNewLines(file, 400)).toEqual({ lines: ['a', 'b'], next: 4 });
  });
});

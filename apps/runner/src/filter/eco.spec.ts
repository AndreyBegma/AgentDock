import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type FilterStatRow, filterStatsDataSchema } from '@nautelle/shared';
import type {
  UnsequencedEvent,
  WatchedProject,
} from '@nautelle/shared/protocol';
import { createLogger } from '../log';
import {
  type EcoSession,
  ecoSessionsDir,
  findEcoStatsFiles,
  parseEcoLines,
  TranscriptCwds,
} from './eco';
import { FILTER_STATS_FILE } from './env';
import { FILTER_STATS_OFFSET_FILE, FilterStatsReader } from './stats-reader';

const SID = '0f9a3c2e-1b2c-4d5e-8f90-123456789abc';

/** A row as `/cs-eco` writes it today: `skill`, its session as the run. */
const ecoLine = (
  id: string,
  projectId = 'acme/widget',
  row: Record<string, unknown> = {},
) =>
  JSON.stringify({
    projectId,
    row: {
      id,
      runId: SID,
      runKind: 'skill',
      filter: 'js/jest',
      rawBytes: 1000,
      keptBytes: 100,
      bypassed: false,
      passedThrough: false,
      at: '2026-10-16T12:00:00.000Z',
      ...row,
    },
  });

const session: EcoSession = {
  sessionId: SID,
  projectId: 'p1',
  repo: 'acme/widget',
  root: '/srv/dev/widget',
};

describe('cs-eco sessions (#475)', () => {
  it('lives in the XDG state dir, else ~/.local/state', () => {
    expect(ecoSessionsDir({ XDG_STATE_HOME: '/x/state' }, '/home/u')).toBe(
      '/x/state/cs-eco/sessions',
    );
    expect(ecoSessionsDir({}, '/home/u')).toBe(
      '/home/u/.local/state/cs-eco/sessions',
    );
    expect(ecoSessionsDir({ XDG_STATE_HOME: 'rel' }, '/home/u')).toBe(
      '/home/u/.local/state/cs-eco/sessions',
    );
  });

  it('sends a row as manual, without a run', () => {
    const { rows, rejected } = parseEcoLines([ecoLine('c_1')], session);
    expect(rejected).toBe(0);
    expect(rows).toEqual([
      expect.objectContaining({ id: 'c_1', runId: null, runKind: 'manual' }),
    ]);
  });

  it('takes the project by repo, id or root name, in any case', () => {
    for (const name of ['acme/widget', 'Acme/Widget', 'p1', 'widget']) {
      expect(parseEcoLines([ecoLine('c_1', name)], session).rows).toHaveLength(
        1,
      );
    }
  });

  it('rejects a row that names another project', () => {
    const { rows, rejected } = parseEcoLines(
      [ecoLine('c_1', 'acme/other'), ecoLine('c_2')],
      session,
    );
    expect(rows.map((r) => r.id)).toEqual(['c_2']);
    expect(rejected).toBe(1);
  });

  it('rejects another session’s run, a broken row and a non-JSON line', () => {
    const { rows, rejected } = parseEcoLines(
      [
        ecoLine('c_1', 'acme/widget', { runId: 'other-session' }),
        ecoLine('c_2', 'acme/widget', { keptBytes: 2000 }),
        ecoLine('c_3', 'acme/widget', { extra: true }),
        'not json',
        ecoLine('c_4', 'acme/widget', { runId: null, runKind: 'manual' }),
      ],
      session,
    );
    expect(rows.map((r) => r.id)).toEqual(['c_4']);
    expect(rejected).toBe(4);
  });
});

describe('transcript cwds (#475)', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'eco-cwd-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('reads a session’s cwd from its transcript, and looks a miss up later', () => {
    let now = 0;
    const cwds = new TranscriptCwds({
      dirs: () => [join(root, 'missing'), join(root, 'projects')],
      now: () => now,
      retryMs: 1000,
    });
    expect(cwds.cwdOf(SID)).toBeUndefined();

    const dir = join(root, 'projects', '-srv-dev-widget');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${SID}.jsonl`),
      `${JSON.stringify({ type: 'summary' })}\n${JSON.stringify({ type: 'user', cwd: '/srv/dev/widget' })}\n`,
    );
    // Not before the retry is due.
    expect(cwds.cwdOf(SID)).toBeUndefined();
    now = 1000;
    expect(cwds.cwdOf(SID)).toBe('/srv/dev/widget');
    expect(cwds.cwdOf('../etc')).toBeUndefined();
  });
});

describe('filter stats reader: cs-eco sessions (#475)', () => {
  let root: string;
  let events: UnsequencedEvent[];
  let warnings: string[];
  let cwds: Map<string, string>;
  let reader: FilterStatsReader;

  const projects: WatchedProject[] = [{ id: 'p1', root: '/srv/dev/widget' }];

  const sessionFile = (sid: string): string => {
    const dir = join(root, 'sessions', sid);
    mkdirSync(dir, { recursive: true });
    return join(dir, FILTER_STATS_FILE);
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'eco-'));
    events = [];
    warnings = [];
    cwds = new Map();
    reader = new FilterStatsReader({
      roots: () => [],
      eco: {
        dir: join(root, 'sessions'),
        projects: () => projects,
        sessionCwd: (sid) => cwds.get(sid),
      },
      resolve: async (ids) =>
        new Map(
          ids
            .filter((id) => id === 'p1')
            .map((id) => [
              id,
              { repo: 'acme/widget', root: '/srv/dev/widget' },
            ]),
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

  it('sends a session in a watched project as manual rows of that project', async () => {
    const file = sessionFile(SID);
    writeFileSync(file, `${ecoLine('c_1')}\n${ecoLine('c_2', 'acme/other')}\n`);
    cwds.set(SID, '/srv/dev/widget/apps/web');

    await reader.poll();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'filter.stats',
      source: 'runner',
      project: { repo: 'acme/widget', root: '/srv/dev/widget' },
    });
    const data = filterStatsDataSchema.parse(events[0].data);
    expect(data.rows).toEqual([
      expect.objectContaining({ id: 'c_1', runId: null, runKind: 'manual' }),
    ] as FilterStatRow[]);
    expect(warnings.join('')).toContain('foreign rows');

    // Only new rows go next time.
    await reader.poll();
    expect(events).toHaveLength(1);
    appendFileSync(file, `${ecoLine('c_3')}\n`);
    await reader.poll();
    expect(events).toHaveLength(2);
  });

  it('counts a fleet worktree of a watched project for it', async () => {
    writeFileSync(sessionFile(SID), `${ecoLine('c_1')}\n`);
    cwds.set(SID, '/srv/dev/.wt-widget-i26');
    await reader.poll();
    expect(events).toHaveLength(1);
  });

  it('never sends a session outside every watched root', async () => {
    const file = sessionFile(SID);
    writeFileSync(file, `${ecoLine('c_1')}\n`);
    cwds.set(SID, '/srv/dev/other');
    await reader.poll();
    expect(events).toEqual([]);
    expect(
      existsSync(join(root, 'sessions', SID, FILTER_STATS_OFFSET_FILE)),
    ).toBe(false);
  });

  it('waits for a session whose cwd is not known yet', async () => {
    writeFileSync(sessionFile(SID), `${ecoLine('c_1')}\n`);
    await reader.poll();
    expect(events).toEqual([]);
    cwds.set(SID, '/srv/dev/widget');
    await reader.poll();
    expect(events).toHaveLength(1);
  });

  it('finds only session dirs with a stats file', () => {
    sessionFile(SID);
    writeFileSync(sessionFile(SID), '');
    mkdirSync(join(root, 'sessions', 'empty'), { recursive: true });
    mkdirSync(join(root, 'sessions', 'bad name'), { recursive: true });
    writeFileSync(join(root, 'sessions', 'bad name', FILTER_STATS_FILE), '');
    expect(findEcoStatsFiles(join(root, 'sessions'))).toEqual([
      { sessionId: SID, file: join(root, 'sessions', SID, FILTER_STATS_FILE) },
    ]);
    expect(findEcoStatsFiles(join(root, 'none'))).toEqual([]);
  });
});

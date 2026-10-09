import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fleetFixture } from '../../fleet/testing';
import { tempDir } from '../../testing/fixtures';
import { BoardWatcher } from './board';
import { parseBoard } from './parse-board';
import { parseBrief } from './parse-brief';

const fixture = (name: string) =>
  readFileSync(join(import.meta.dir, '__fixtures__', name), 'utf8');

describe('parseBoard', () => {
  it('reads the header and every row of the four tables', () => {
    const parsed = parseBoard(fixture('round-0923.md'));
    if (!parsed.ok) throw new Error(parsed.reason);
    expect(parsed.value.header).toEqual({
      date: '2026-10-08',
      round: '0923',
      repo: 'acme/widget',
      base: 'develop',
      occupied: 3,
      max: 5,
      free: 2,
    });
    const { decisions } = parsed.value;
    expect(decisions.dispatching).toHaveLength(2);
    expect(decisions.dispatching[0]).toEqual({
      Slot: 'i12-adapters',
      Issue: '#12',
      Title: 'agent sessions',
      Kind: 'feature',
      Model: 'opus',
      'Why that model':
        'parallel plan; first runtime adapter, new runner command end to end',
      Lead: 'yes',
      Owns: 'apps/runner/**, shared commands/sessions',
      Worktree: '../.wt-widget-i12-adapters',
      Branch: 'feat/12-session-adapters',
    });
    expect(decisions.heldForLead.map((r) => r.Slot)).toEqual([
      'i11-runner (opus)',
      'i11-web (sonnet)',
    ]);
    expect(decisions.notDispatching.map((r) => r.State)).toEqual([
      'BLOCKED — work',
      'BLOCKED — work',
    ]);
    expect(decisions.inFlight).toEqual([
      {
        'Slot / PR': 'i11-api',
        Issue: '#11',
        'Where it got to':
          'done locally (f465a48, checks green), blocked on push',
      },
    ]);
  });

  it('keeps unknown columns and short rows', () => {
    const parsed = parseBoard(
      [
        '# Round 2026-10-08 1100 · acme/widget · base main · occupied 0/4 · free 4',
        '## Held for a lead',
        '| Slot | Waiting on | Dispatch when | Note |',
        '|:---|---|---:|---|',
        '| i9 | i8 \\| i7 | merged | x | extra |',
        '| i10 | i8 |',
      ].join('\n'),
    );
    expect(parsed.ok && parsed.value.decisions.heldForLead).toEqual([
      {
        Slot: 'i9',
        'Waiting on': 'i8 | i7',
        'Dispatch when': 'merged',
        Note: 'x',
        col5: 'extra',
      },
      { Slot: 'i10', 'Waiting on': 'i8', 'Dispatch when': '', Note: '' },
    ]);
  });

  it('fails with a line on a board that does not parse', () => {
    expect(parseBoard(fixture('round-1000-malformed.md'))).toEqual({
      ok: false,
      line: 5,
      reason: 'table header is not followed by a separator row',
    });
    expect(parseBoard('# Round tomorrow\n')).toMatchObject({
      ok: false,
      line: 1,
    });
    expect(parseBoard('')).toMatchObject({ ok: false });
  });
});

describe('parseBrief', () => {
  it('reads the fields, the model and its reason, and the fence globs', () => {
    const parsed = parseBrief(fixture('round-0923-i12-adapters.md'));
    expect(parsed).toEqual({
      ok: true,
      value: {
        slot: 'i12-adapters',
        issue: 12,
        branch: 'feat/12-session-adapters',
        base: 'develop',
        worktree: '/srv/.wt-widget-i12-adapters',
        runtime: 'claude',
        model: 'opus',
        modelWhy:
          'the parallel plan assigns opus; first runtime adapter, new runner command end to end',
        owns: [
          'apps/runner/src/adapters/**',
          'packages/shared/src/sessions/**',
          '.orchestrator-reply.md',
        ],
        never: ['apps/web/**', 'apps/api/prisma/**'],
      },
    });
  });

  it('reads a Codex runtime and a model without a reason', () => {
    const parsed = parseBrief(
      '# Brief — i7\n\nRuntime: codex\nModel: gpt-5.5\n',
    );
    expect(parsed.ok && parsed.value).toMatchObject({
      runtime: 'codex',
      model: 'gpt-5.5',
    });
    expect(parsed.ok && parsed.value.modelWhy).toBeUndefined();
  });

  it('fails without the title', () => {
    expect(parseBrief('Issue: #4\n')).toMatchObject({ ok: false, line: 1 });
  });
});

describe('BoardWatcher', () => {
  let dir = '';
  let cleanup = () => {};
  beforeEach(() => {
    ({ dir, cleanup } = tempDir());
  });
  afterEach(() => cleanup());

  const setup = () => {
    const f = fleetFixture({ root: join(dir, 'widget'), boardDir: dir });
    const watcher = new BoardWatcher(f);
    const put = (date: string, name: string, text: string) => {
      mkdirSync(join(dir, date), { recursive: true });
      writeFileSync(join(dir, date, name), text);
      return join(dir, date, name);
    };
    return { ...f, watcher, put };
  };

  it('emits the round, its decisions and the brief, once', () => {
    const { watcher, events, put, book } = setup();
    const board = put('2026-10-08', 'round-0923.md', fixture('round-0923.md'));
    const brief = put(
      '2026-10-08',
      'round-0923-i12-adapters.md',
      fixture('round-0923-i12-adapters.md'),
    );
    watcher.scan();
    const emitted = events.take();
    expect(emitted.map((e) => e.type)).toEqual([
      'round.started',
      'round.decided',
      'slot.dispatched',
    ]);
    expect(emitted.every((e) => e.source === 'scraped')).toBe(true);
    expect(emitted[0].data).toEqual({
      date: '2026-10-08',
      round: '0923',
      base: 'develop',
      occupied: 3,
      max: 5,
      free: 2,
      boardPath: board,
    });
    expect(emitted[2]).toMatchObject({
      slot: 'i12-adapters',
      issue: 12,
      data: {
        briefPath: brief,
        model: 'opus',
        lead: true,
        branch: 'feat/12-session-adapters',
        owns: [
          'apps/runner/src/adapters/**',
          'packages/shared/src/sessions/**',
          '.orchestrator-reply.md',
        ],
      },
    });
    expect(book.briefs.get('i12-adapters')).toMatchObject({
      round: '2026-10-08/0923',
      base: 'develop',
      issue: 12,
    });

    watcher.scan();
    expect(events.take()).toEqual([]);
  });

  it('emits only the newest brief of a slot, and skips boards older than a week', () => {
    const { watcher, events, put } = setup();
    put('2026-09-20', 'round-0900.md', fixture('round-0923.md'));
    put(
      '2026-10-07',
      'round-2226-i12-web.md',
      '# Brief — i12-web\nModel: opus — old\n',
    );
    put(
      '2026-10-08',
      'round-0923-i12-web.md',
      '# Brief — i12-web\nModel: sonnet — new\n',
    );
    watcher.scan();
    const emitted = events.take();
    expect(emitted.map((e) => [e.type, e.data])).toEqual([
      [
        'slot.dispatched',
        expect.objectContaining({ round: '0923', model: 'sonnet' }),
      ],
    ]);
  });

  it('reports a malformed board and keeps scanning', () => {
    const { watcher, events, put } = setup();
    const bad = put(
      '2026-10-08',
      'round-1000.md',
      fixture('round-1000-malformed.md'),
    );
    put('2026-10-08', 'round-0923.md', fixture('round-0923.md'));
    expect(() => watcher.scan()).not.toThrow();
    const emitted = events.take();
    expect(emitted.map((e) => e.type)).toEqual([
      'round.started',
      'round.decided',
      'board.unparsed',
    ]);
    expect(emitted[2].data).toEqual({
      file: bad,
      line: 5,
      reason: 'table header is not followed by a separator row',
    });
  });

  it('rereads a board that changed', () => {
    const { watcher, events, put } = setup();
    const path = put('2026-10-08', 'round-0923.md', fixture('round-0923.md'));
    watcher.scan();
    events.take();
    writeFileSync(
      path,
      fixture('round-0923.md').replace(
        'occupied 3/5 · free 2',
        'occupied 4/5 · free 1',
      ),
    );
    utimesSync(path, new Date(), new Date(Date.now() + 5_000));
    watcher.scan();
    expect(events.take().map((e) => e.data)).toContainEqual(
      expect.objectContaining({ occupied: 4, free: 1 }),
    );
  });
});

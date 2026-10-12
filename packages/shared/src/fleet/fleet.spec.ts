import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  eventSchema,
  FLEET_EVENT_TYPES,
  isFleetEventType,
  parseFleetEvent,
  type RunnerEvent,
  runnerMessageSchema,
} from '../protocol';
import { checkpointFromHeading, rollupChecks } from './checks';

const event = (
  type: string,
  data: unknown,
  extra: Partial<RunnerEvent> = {},
): RunnerEvent =>
  eventSchema.parse({
    v: 1,
    seq: 1,
    ts: '2026-10-08T10:00:00.000Z',
    type,
    source: 'runner',
    project: { repo: 'acme/widget', root: '/srv/widget' },
    ...extra,
    data,
  });

describe('rollupChecks', () => {
  const run = (conclusion: string | null, status = 'COMPLETED') => ({
    status,
    conclusion,
  });

  it('is green when every conclusion is success, neutral or skipped', () => {
    expect(rollupChecks([run('SUCCESS'), run('NEUTRAL'), run('SKIPPED')])).toBe(
      'green',
    );
    expect(rollupChecks([{ state: 'SUCCESS' }])).toBe('green');
  });

  it('is green with no checks', () => {
    expect(rollupChecks([])).toBe('green');
  });

  it('is pending while a check has not finished', () => {
    expect(rollupChecks([run('SUCCESS'), run(null, 'IN_PROGRESS')])).toBe(
      'pending',
    );
    expect(rollupChecks([run('SUCCESS'), run(null, 'QUEUED')])).toBe('pending');
    expect(rollupChecks([{ state: 'PENDING' }])).toBe('pending');
  });

  it('is red on one failure, even while others are pending', () => {
    expect(rollupChecks([run('SUCCESS'), run('FAILURE')])).toBe('red');
    expect(rollupChecks([run(null, 'IN_PROGRESS'), run('CANCELLED')])).toBe(
      'red',
    );
    expect(rollupChecks([{ state: 'ERROR' }])).toBe('red');
    expect(rollupChecks([run('TIMED_OUT')])).toBe('red');
  });
});

describe('checkpointFromHeading', () => {
  it.each([
    ['picked up', 'picked_up'],
    ['plan ready', 'plan_ready'],
    ['Implementation done and checks green', 'implementation_done'],
    ['blocked', 'blocked'],
    ['misclassified', 'misclassified'],
    ['notes for the reviewer', 'other'],
    ['blockedness', 'other'],
  ] as const)('maps "%s" to %s', (heading, checkpoint) => {
    expect(checkpointFromHeading(heading)).toEqual({ checkpoint });
  });

  it('takes the URL from a pull request heading', () => {
    expect(
      checkpointFromHeading(
        'pull request open — https://github.com/acme/widget/pull/7',
      ),
    ).toEqual({
      checkpoint: 'pr_open',
      prUrl: 'https://github.com/acme/widget/pull/7',
    });
    expect(checkpointFromHeading('pull request open')).toEqual({
      checkpoint: 'pr_open',
    });
  });
});

describe('fleet events', () => {
  it('accepts source "scraped" on the envelope', () => {
    expect(event('round.started', {}, { source: 'scraped' }).source).toBe(
      'scraped',
    );
  });

  it('returns null for a type that is not a fleet event', () => {
    expect(parseFleetEvent(event('llm.request', {}))).toBeNull();
  });

  it('parses a slot checkpoint', () => {
    const parsed = parseFleetEvent(
      event(
        'slot.checkpoint',
        {
          checkpoint: 'pr_open',
          heading: 'pull request open — https://github.com/acme/widget/pull/7',
          summary: 'done',
          position: 3,
          prUrl: 'https://github.com/acme/widget/pull/7',
        },
        { slot: 'i42-api', issue: 42, source: 'scraped' },
      ),
    );
    expect(parsed).toMatchObject({
      ok: true,
      event: { type: 'slot.checkpoint', data: { position: 3 } },
    });
  });

  it('fills defaults of a brief', () => {
    const parsed = parseFleetEvent(
      event(
        'slot.dispatched',
        {
          date: '2026-10-08',
          round: '1430',
          briefPath:
            '/srv/widget/.git/cs-orchestrator/2026-10-08/round-1430-i42.md',
        },
        { slot: 'i42' },
      ),
    );
    expect(parsed?.ok && parsed.event.data).toMatchObject({
      runtime: 'claude',
      owns: [],
      never: [],
    });
  });

  it('defaults a pane event to the slot target', () => {
    const parsed = parseFleetEvent(
      event('pane.idle', { polls: 3 }, { slot: 'i42' }),
    );
    expect(parsed?.ok && parsed.event.data).toEqual({
      target: 'slot',
      polls: 3,
    });
  });

  it('accepts an orchestrator pane event without a slot', () => {
    expect(
      parseFleetEvent(event('pane.busy', { target: 'orchestrator' }))?.ok,
    ).toBe(true);
  });

  it('refuses a slot event without an envelope slot', () => {
    expect(parseFleetEvent(event('pane.idle', { polls: 3 }))).toMatchObject({
      ok: false,
    });
    expect(
      parseFleetEvent(event('session.appeared', { name: 'cs-i42' })),
    ).toMatchObject({ ok: false });
  });

  it('refuses malformed data', () => {
    expect(
      parseFleetEvent(
        event('round.started', {
          date: '2026-10-08',
          round: '14:30',
          base: 'develop',
          occupied: 1,
          max: 3,
          free: 2,
          boardPath: '/x',
        }),
      ),
    ).toMatchObject({ ok: false });
  });

  it('parses the spec 16 types: snapshot, unparsed, merged, redispatched', () => {
    const snapshot = parseFleetEvent(
      event(
        'orchestrator.snapshot',
        { state: { v: 1, slots: { 'i42-api': { model: 'opus' } } } },
        { source: 'code-sentinel' },
      ),
    );
    expect(snapshot).toMatchObject({
      ok: true,
      event: { data: { state: { slots: { 'i42-api': { model: 'opus' } } } } },
    });
    expect(
      parseFleetEvent(
        event('events.unparsed', {
          file: '/srv/widget/.git/cs-orchestrator/events.jsonl',
          line: '{"v":99}',
          offset: 0,
          reason: 'unsupported schema version 99',
        }),
      )?.ok,
    ).toBe(true);
    expect(parseFleetEvent(event('pr.merged', { number: 7 }))?.ok).toBe(true);
    expect(
      parseFleetEvent(event('slot.redispatched', { toModel: 'opus' }))?.ok,
    ).toBe(false);
    expect(
      parseFleetEvent(
        event('slot.redispatched', { toModel: 'opus' }, { slot: 'i42' }),
      )?.ok,
    ).toBe(true);
  });

  it('takes an optional head commit on pr.opened and pr.checks_changed (spec 20 D6)', () => {
    const head = 'a'.repeat(40);
    const opened = {
      number: 7,
      branch: 'feat/42-x',
      url: 'https://github.com/acme/widget/pull/7',
      title: 'PR 7',
      checks: 'green',
    };
    const changed = { number: 7, branch: 'feat/42-x', checks: 'pending' };
    for (const [type, data] of [
      ['pr.opened', opened],
      ['pr.checks_changed', changed],
    ] as const) {
      // An event from a runner older than the field still parses.
      expect(parseFleetEvent(event(type, data))).toMatchObject({ ok: true });
      expect(
        parseFleetEvent(event(type, { ...data, headSha: head })),
      ).toMatchObject({ ok: true, event: { data: { headSha: head } } });
      for (const headSha of ['abc123', 'A'.repeat(40), 42]) {
        expect(
          parseFleetEvent(event(type, { ...data, headSha })),
        ).toMatchObject({ ok: false });
      }
    }
  });

  it('still requires what spec 11 collectors always send', () => {
    expect(
      parseFleetEvent(
        event('round.started', {
          date: '2026-10-08',
          round: '1430',
          occupied: 1,
          max: 3,
          free: 2,
          boardPath: '/b.md',
        }),
      )?.ok,
    ).toBe(true);
    expect(
      parseFleetEvent(
        event('round.started', { round: '1430', boardPath: '/b.md' }),
      )?.ok,
    ).toBe(false);
  });

  it('lists every type once', () => {
    expect(new Set(FLEET_EVENT_TYPES).size).toBe(FLEET_EVENT_TYPES.length);
    expect(FLEET_EVENT_TYPES).toContain('pane.busy');
    expect(FLEET_EVENT_TYPES).toContain('board.unparsed');
  });

  it('parses every fleet event documented in runner-protocol.md', () => {
    const markdown = readFileSync(
      join(__dirname, '../../../../docs/architecture/runner-protocol.md'),
      'utf8',
    );
    const documented = [...markdown.matchAll(/```json\n([\s\S]*?)```/g)]
      .map((m): unknown => JSON.parse(m[1]))
      .filter((m) => (m as { type?: unknown }).type === 'events')
      .map((m) => runnerMessageSchema.parse(m))
      .flatMap((m) => (m.type === 'events' ? m.events : []))
      .filter((e) => isFleetEventType(e.type));
    expect(documented.length).toBeGreaterThan(0);
    for (const e of documented) {
      expect([e.type, parseFleetEvent(e)?.ok]).toEqual([e.type, true]);
    }
  });
});

import { describe, expect, it } from 'bun:test';
import {
  HANDOFF_EVENT_TYPES,
  HANDOFF_UPDATED_EVENT,
  handoffEventDataSchemas,
  handoffUpdatedDataSchema,
  isHandoffEventType,
  ROUND_RESTART_EVENT,
  ROUND_WARMUP_EVENT,
  roundRestartDataSchema,
  roundWarmupDataSchema,
} from './events';
import { HANDOFF_NOTE_TEMPLATE } from './note';

const at = '2026-10-16T10:00:00.000Z';
const content = HANDOFF_NOTE_TEMPLATE.replace(
  '## Goal\n',
  '## Goal\nShip it.\n',
);
const OLD = '11111111-1111-4111-8111-111111111111';
const NEW = '22222222-2222-4222-8222-222222222222';

describe('handoff.updated (#449 D4)', () => {
  const event = {
    projectId: 'p1',
    at,
    subject: { kind: 'card', cardId: 'cmcard01' },
    updatedBy: 'agent',
    content,
    personLines: [],
  };
  const ok = (data: unknown) =>
    handoffUpdatedDataSchema.safeParse(data).success;

  it('takes a card note and a run note', () => {
    expect(ok(event)).toBe(true);
    expect(ok({ ...event, subject: { kind: 'run', runId: 'cmrun001' } })).toBe(
      true,
    );
  });

  it('refuses a note that breaks the format', () => {
    expect(ok({ ...event, content: '## Goal\nx\n' })).toBe(false);
  });

  it('refuses person lines past the end, and an unknown author', () => {
    expect(ok({ ...event, personLines: [{ from: 999, to: 999 }] })).toBe(false);
    expect(ok({ ...event, updatedBy: 'steward' })).toBe(false);
  });

  it('refuses a subject that mixes card and run', () => {
    expect(
      ok({ ...event, subject: { kind: 'card', cardId: 'c1', runId: 'r1' } }),
    ).toBe(false);
  });
});

describe('round.restart (#449 D3)', () => {
  const base = { projectId: 'p1', cardId: 'cmcard01', runId: 'cmrun001', at };
  const estimate = {
    resumeTokens: 180_000,
    freshTokens: 6_000,
    cacheWarm: false,
  };
  const ok = (data: unknown) => roundRestartDataSchema.safeParse(data).success;

  it('records a resume with both estimates', () => {
    expect(ok({ ...base, mode: 'resume', estimate, sessionId: OLD })).toBe(
      true,
    );
  });

  it('records a fresh start with the session it did not resume', () => {
    expect(
      ok({
        ...base,
        mode: 'fresh',
        estimate,
        sessionId: NEW,
        previousSessionId: OLD,
      }),
    ).toBe(true);
    expect(ok({ ...base, mode: 'fresh', estimate, sessionId: NEW })).toBe(
      false,
    );
    expect(
      ok({
        ...base,
        mode: 'fresh',
        estimate,
        sessionId: OLD,
        previousSessionId: OLD,
      }),
    ).toBe(false);
  });

  it('keeps previousSessionId to fresh starts', () => {
    expect(
      ok({
        ...base,
        mode: 'resume',
        estimate,
        sessionId: OLD,
        previousSessionId: NEW,
      }),
    ).toBe(false);
  });

  it('has no estimate exactly for a first round', () => {
    expect(ok({ ...base, mode: 'first', estimate: null, sessionId: OLD })).toBe(
      true,
    );
    expect(ok({ ...base, mode: 'first', estimate, sessionId: OLD })).toBe(
      false,
    );
    expect(
      ok({ ...base, mode: 'resume', estimate: null, sessionId: OLD }),
    ).toBe(false);
  });

  it('refuses a malformed estimate', () => {
    expect(
      ok({
        ...base,
        mode: 'resume',
        estimate: { ...estimate, resumeTokens: -1 },
        sessionId: OLD,
      }),
    ).toBe(false);
    expect(
      ok({
        ...base,
        mode: 'resume',
        estimate: { ...estimate, extra: 1 },
        sessionId: OLD,
      }),
    ).toBe(false);
  });
});

describe('round.warmup (#449 D9)', () => {
  const event = {
    projectId: 'p1',
    cardId: 'cmcard01',
    runId: 'cmrun001',
    at,
    tokens: 42_000,
    ms: 95_000,
  };

  it('takes tokens and ms that fit an INTEGER', () => {
    expect(roundWarmupDataSchema.safeParse(event).success).toBe(true);
    expect(
      roundWarmupDataSchema.safeParse({ ...event, ms: 2 ** 31 }).success,
    ).toBe(false);
    expect(
      roundWarmupDataSchema.safeParse({ ...event, tokens: 1.5 }).success,
    ).toBe(false);
  });
});

describe('handoff event types', () => {
  it('names the three runner events', () => {
    expect(HANDOFF_EVENT_TYPES).toEqual([
      HANDOFF_UPDATED_EVENT,
      ROUND_RESTART_EVENT,
      ROUND_WARMUP_EVENT,
    ]);
    expect(HANDOFF_EVENT_TYPES.every(isHandoffEventType)).toBe(true);
    expect(isHandoffEventType('steward.observed')).toBe(false);
    expect(Object.keys(handoffEventDataSchemas)).toEqual(HANDOFF_EVENT_TYPES);
  });
});

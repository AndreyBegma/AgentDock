import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { activityFromEvent } from '../activity';
import { API_EVENT_SOURCE, eventsMessageSchema } from '../protocol';
import {
  isStewardEventType,
  STEWARD_ACTED_EVENT,
  STEWARD_ACTIVITY_TYPES,
  STEWARD_INCIDENT_EVENTS,
  STEWARD_OBSERVED_EVENT,
  type StewardIncidentEventData,
  stewardActedDataSchema,
  stewardEventDataSchemas,
  stewardIncidentTitle,
  stewardObservedDataSchema,
} from './events';

const at = '2026-10-16T12:00:00.000Z';
const card = { kind: 'card_round', cardId: 'cmcard01', runId: 'cmrun001' };
const observed = {
  projectId: 'p1',
  at,
  subject: card,
  kind: 'api_error',
  reason: 'API Error: Connection lost mid-response',
};

describe('steward.observed (#447 D6, D12)', () => {
  it('accepts a card round, a run and a fleet slot', () => {
    for (const subject of [
      card,
      { kind: 'run', runId: 'cmrun002' },
      { kind: 'fleet_slot', slot: 'i447-contract' },
    ]) {
      expect(
        stewardObservedDataSchema.safeParse({ ...observed, subject }).success,
      ).toBe(true);
    }
  });

  it('takes a dialog id with a dialog only, and only a listed one', () => {
    expect(
      stewardObservedDataSchema.safeParse({
        ...observed,
        kind: 'dialog',
        dialogId: 'teach-auto-mode',
      }).success,
    ).toBe(true);
    expect(
      stewardObservedDataSchema.safeParse({
        ...observed,
        dialogId: 'teach-auto-mode',
      }).success,
    ).toBe(false);
    expect(
      stewardObservedDataSchema.safeParse({
        ...observed,
        kind: 'dialog',
        dialogId: 'allow-bash',
      }).success,
    ).toBe(false);
  });

  it('takes haiku’s session with an unknown stall only (D16)', () => {
    const classifierSessionId = '0f8fad5b-d9cb-469f-a165-70867728950e';
    expect(
      stewardObservedDataSchema.safeParse({
        ...observed,
        kind: 'unknown',
        reason: 'Waiting on a long migration with no output',
        classifierSessionId,
      }).success,
    ).toBe(true);
    expect(
      stewardObservedDataSchema.safeParse({ ...observed, classifierSessionId })
        .success,
    ).toBe(false);
  });

  it('bounds the pane tail and keeps the reason to one line', () => {
    expect(
      stewardObservedDataSchema.safeParse({ ...observed, paneTail: '❯ ' })
        .success,
    ).toBe(true);
    expect(
      stewardObservedDataSchema.safeParse({
        ...observed,
        paneTail: 'x'.repeat(4097),
      }).success,
    ).toBe(false);
    expect(
      stewardObservedDataSchema.safeParse({ ...observed, reason: 'a\nb' })
        .success,
    ).toBe(false);
  });

  it('refuses a subject that names a path or a tmux session', () => {
    expect(
      stewardObservedDataSchema.safeParse({
        ...observed,
        subject: { kind: 'run', runId: '../etc' },
      }).success,
    ).toBe(false);
    expect(
      stewardObservedDataSchema.safeParse({
        ...observed,
        subject: { ...card, tmuxSession: 'nautelle-card-abcd1234' },
      }).success,
    ).toBe(false);
  });
});

describe('steward.acted (D2, D5)', () => {
  const acted = {
    projectId: 'p1',
    at,
    subject: card,
    action: 'nudge',
    result: 'ok',
  };

  it('accepts an action on a card round or a run', () => {
    expect(stewardActedDataSchema.safeParse(acted).success).toBe(true);
    expect(
      stewardActedDataSchema.safeParse({
        ...acted,
        action: 'hold_push',
        detail: '2 commits to rewrite',
      }).success,
    ).toBe(true);
  });

  it('never names a fleet slot', () => {
    expect(
      stewardActedDataSchema.safeParse({
        ...acted,
        subject: { kind: 'fleet_slot', slot: 'i1' },
      }).success,
    ).toBe(false);
  });

  it('is a known runner event type', () => {
    expect(isStewardEventType(STEWARD_OBSERVED_EVENT)).toBe(true);
    expect(isStewardEventType(STEWARD_ACTED_EVENT)).toBe(true);
    expect(isStewardEventType('steward.answered')).toBe(false);
  });
});

describe('runner-protocol.md examples', () => {
  it('parse as Steward events', () => {
    const markdown = readFileSync(
      join(__dirname, '../../../../docs/architecture/runner-protocol.md'),
      'utf8',
    );
    const events = [...markdown.matchAll(/```json\n([\s\S]*?)```/g)]
      .map((m) => eventsMessageSchema.safeParse(JSON.parse(m[1])))
      .flatMap((r) => (r.success ? r.data.events : []))
      .filter((e) => isStewardEventType(e.type));
    expect(events.map((e) => e.type).sort()).toEqual([
      STEWARD_ACTED_EVENT,
      STEWARD_OBSERVED_EVENT,
    ]);
    for (const event of events) {
      const schema =
        stewardEventDataSchemas[
          event.type as keyof typeof stewardEventDataSchemas
        ];
      expect(schema.safeParse(event.data).success).toBe(true);
    }
  });
});

describe('steward_incident.* in Activity (D13, D15)', () => {
  const data: StewardIncidentEventData = {
    incidentId: 'inc1',
    subjectKind: 'card_round',
    subjectId: 'round1',
    subjectLabel: 'C-12',
    cardNumber: 12,
    kind: 'api_error',
    reason: 'API Error: Connection lost mid-response',
  };
  const source = (type: string, extra: Record<string, unknown> = {}) => ({
    runnerId: 'r1',
    type,
    source: API_EVENT_SOURCE,
    slot: null,
    issue: null,
    data: { ...data, ...extra },
  });

  it('titles each step', () => {
    expect(stewardIncidentTitle(STEWARD_INCIDENT_EVENTS.opened, data)).toBe(
      'C-12 stuck: API error — API Error: Connection lost mid-response',
    );
    expect(
      stewardIncidentTitle(STEWARD_INCIDENT_EVENTS.acted, {
        ...data,
        action: 'nudge',
        result: 'ok',
        attempt: 1,
      }),
    ).toBe('Steward nudged C-12 (1/2)');
    expect(
      stewardIncidentTitle(STEWARD_INCIDENT_EVENTS.acted, {
        ...data,
        action: 'resume',
        result: 'failed',
      }),
    ).toBe('Steward could not resume C-12');
    expect(stewardIncidentTitle(STEWARD_INCIDENT_EVENTS.resolved, data)).toBe(
      'C-12 recovered (API error)',
    );
  });

  it('becomes a system item linking the card, from the API only', () => {
    const item = activityFromEvent(
      source(STEWARD_INCIDENT_EVENTS.escalated),
      'p1',
    );
    expect(item?.actorType).toBe('system');
    expect(item?.severity).toBe('danger');
    expect(item?.title).toBe(
      'C-12 needs you: API Error: Connection lost mid-response',
    );
    expect(item?.link).toBe('/projects/p1/board?card=12');
    expect(
      activityFromEvent(
        { ...source(STEWARD_INCIDENT_EVENTS.opened), source: 'runner' },
        'p1',
      ),
    ).toBeNull();
  });

  it('shows no runner observation as an item', () => {
    expect(
      activityFromEvent(
        { ...source(STEWARD_OBSERVED_EVENT), source: 'runner' },
        'p1',
      ),
    ).toBeNull();
  });

  it('lists every type for the Steward filter', () => {
    expect([...STEWARD_ACTIVITY_TYPES].sort()).toEqual(
      Object.values(STEWARD_INCIDENT_EVENTS).sort(),
    );
  });
});

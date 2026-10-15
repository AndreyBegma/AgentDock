import { describe, expect, test } from 'bun:test';
import { ApiError } from '../api';
import { acceptChoice } from './accept';
import { decideDrop } from './board-state';
import { boardView, card, round } from './fixtures';
import {
  canAccept,
  canDelete,
  canGiveFeedback,
  canMarkFinished,
  canRetry,
  canRun,
  canStop,
  describeBoardError,
  fleetHref,
  fleetSummary,
  MOVE_REFUSAL_TEXT,
  trackedSessionHref,
} from './format';

const drop = (id: string, from: string, to: string, index = 0) => ({
  id,
  fromColumnId: from,
  toColumnId: to,
  index,
});

const terminal = (
  number: number,
  column: 'in_progress' | 'finished' | 'todo',
  alive: boolean,
  extra: Parameters<typeof card>[2] = {},
) =>
  card(number, column, {
    source: 'terminal',
    tracking: { sessionId: 's-1', alive },
    ...extra,
  });

const fleet = (
  number: number,
  column: 'todo' | 'in_progress' | 'finished',
  extra: Parameters<typeof card>[2] = {},
) =>
  card(number, column, {
    source: 'fleet',
    fleet: { issue: 12, slot: 'i12-web', stage: 'pr_open', slotGone: false },
    ...extra,
  });

describe('a live terminal card', () => {
  test('offers no Run, Stop, feedback or retry: the session is the work', () => {
    const live = terminal(1, 'in_progress', true);
    expect(canRun(live)).toBe(false);
    expect(canStop(live)).toBe(false);
    expect(canRetry(live)).toBe(false);
    expect(canMarkFinished(live)).toBe(false);
  });

  test('once the session ended, Finished offers Accept, Run and feedback', () => {
    const done = terminal(1, 'finished', false);
    expect(canAccept(done)).toBe(true);
    expect(canRun(done)).toBe(true);
    expect(canGiveFeedback(done)).toBe(true);
  });

  test('links its session', () => {
    expect(trackedSessionHref(terminal(1, 'in_progress', true))).toBe(
      '/sessions/s-1',
    );
    expect(trackedSessionHref(card(1, 'todo'))).toBeNull();
  });

  test('Finished → Completed is a plain move, with or without Automatic work', () => {
    for (const autoCollect of [false, true]) {
      const view = boardView([terminal(1, 'finished', false, { autoCollect })]);
      expect(
        decideDrop(view, drop('card-1', 'finished', 'completed')).kind,
      ).toBe('move');
    }
  });
});

describe('a fleet card', () => {
  test('has no worker of its own and cannot be deleted', () => {
    const slot = fleet(1, 'in_progress', { round: round('running') });
    expect(canStop(slot)).toBe(false);
    expect(canMarkFinished(slot)).toBe(false);
    expect(canRun(fleet(2, 'todo'))).toBe(false);
    expect(canGiveFeedback(fleet(3, 'finished'))).toBe(false);
    expect(canDelete(slot)).toBe(false);
    expect(canDelete(card(4, 'todo'))).toBe(true);
  });

  test('a drag is refused fleet_slot, with its text', () => {
    const view = boardView([fleet(1, 'in_progress')]);
    for (const to of ['todo', 'finished', 'completed']) {
      const decision = decideDrop(view, drop('card-1', 'in_progress', to));
      expect(decision.kind).toBe('refused');
      if (decision.kind === 'refused') {
        expect(decision.error).toBe('fleet_slot');
        expect(decision.text).toBe(MOVE_REFUSAL_TEXT.fleet_slot);
      }
    }
  });

  test('Finished → Completed by hand is allowed', () => {
    const view = boardView([fleet(1, 'finished')]);
    expect(decideDrop(view, drop('card-1', 'finished', 'completed')).kind).toBe(
      'move',
    );
  });

  test('Accept never merges', () => {
    expect(acceptChoice(7, null, { fleet: true })).toMatchObject({
      kind: 'accept_only',
    });
  });

  test('summary and Fleet link follow the slot', () => {
    const slot = fleet(1, 'in_progress');
    expect(slot.fleet && fleetSummary(slot.fleet)).toBe('i12-web · PR open');
    expect(fleetHref('p1', slot)).toBe(
      '/projects/p1/fleet?open=i12-web&focus=i12-web',
    );
    const waiting = fleet(2, 'todo', {
      fleet: { issue: 13, slot: null, stage: null, slotGone: false },
    });
    expect(waiting.fleet && fleetSummary(waiting.fleet)).toBe(
      'Waiting for a slot',
    );
    expect(fleetHref('p1', waiting)).toBeNull();
  });
});

describe('not_tracked', () => {
  test('reads as a sentence', () => {
    const err = new ApiError(
      422,
      'not_tracked' as ApiError['code'],
      'x',
      undefined,
      null,
    );
    expect(describeBoardError(err)).toContain('terminal session');
  });
});

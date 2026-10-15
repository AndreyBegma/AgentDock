import { describe, expect, test } from 'bun:test';
import type { CardCaptureView } from '@agentdock/shared';
import { ApiError } from '../api';
import { boardView, card } from './fixtures';
import {
  CAPTURE_SKIP_TEXT,
  captureOutcome,
  columnsOf,
  confidenceLabel,
  describeBoardError,
  isSuggestion,
  sessionHref,
} from './format';

const capture = (extra: Partial<CardCaptureView> = {}): CardCaptureView => ({
  id: 'cap-1',
  sessionId: 's1',
  status: 'succeeded',
  skipReason: null,
  error: null,
  suggested: 0,
  inputChars: 1200,
  runId: 'r1',
  costUsd: null,
  createdAt: '2026-10-15T10:00:00.000Z',
  finishedAt: null,
  ...extra,
});

describe('the Inbox column', () => {
  test('an operator sees it first, even empty', () => {
    const columns = columnsOf(boardView([card(1, 'todo')]));
    expect(columns.map((c) => c.column)).toEqual([
      'inbox',
      'todo',
      'in_progress',
      'finished',
      'completed',
    ]);
  });

  test('a viewer’s board has no Inbox and the page does not invent one', () => {
    const view = boardView([card(1, 'todo')]);
    const viewer = {
      ...view,
      columns: view.columns.filter((c) => c.column !== 'inbox'),
    };
    expect(columnsOf(viewer).map((c) => c.column)).not.toContain('inbox');
  });

  test('only an Inbox card is a suggestion', () => {
    expect(isSuggestion(card(1, 'inbox'))).toBe(true);
    expect(isSuggestion(card(2, 'todo', { source: 'captured' }))).toBe(false);
  });
});

describe('suggestion helpers', () => {
  test('confidence is a whole percent, clamped; none for a manual card', () => {
    expect(confidenceLabel(0.74)).toBe('74%');
    expect(confidenceLabel(1.4)).toBe('100%');
    expect(confidenceLabel(null)).toBeNull();
  });

  test('the source session links to its page; none once it is gone', () => {
    expect(sessionHref('abc')).toBe('/sessions/abc');
    expect(sessionHref(null)).toBeNull();
  });
});

describe('captureOutcome', () => {
  test('says the skip reason, the error or the count', () => {
    expect(
      captureOutcome(capture({ status: 'skipped', skipReason: 'inbox_full' })),
    ).toBe('Inbox is full');
    expect(
      captureOutcome(
        capture({
          status: 'failed',
          error: 'contract_violation: too_many_cards',
        }),
      ),
    ).toBe('contract_violation: too_many_cards');
    expect(captureOutcome(capture({ suggested: 1 }))).toBe('1 card suggested');
    expect(captureOutcome(capture({ suggested: 3 }))).toBe('3 cards suggested');
  });
});

describe('describeBoardError (#244)', () => {
  test('capture without content points to the Sessions setting', () => {
    const err = new ApiError(422, 'capture_needs_content' as never, 'x');
    expect(describeBoardError(err)).toContain('Keep session content');
  });

  test('a capture skipped for want of a profile says so', () => {
    expect(
      captureOutcome(capture({ status: 'skipped', skipReason: 'no_profile' })),
    ).toBe('No runtime profile');
    expect(CAPTURE_SKIP_TEXT.no_profile).toBe('No runtime profile');
  });

  test('an invalid move explains how a suggestion leaves the Inbox', () => {
    const err = new ApiError(409, 'invalid_move' as never, 'x');
    expect(describeBoardError(err)).toContain('Accept');
  });
});

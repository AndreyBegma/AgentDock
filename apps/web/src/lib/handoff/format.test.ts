import { describe, expect, test } from 'bun:test';
import { HANDOFF_NOTE_TEMPLATE } from '@nautelle/shared';
import { ApiError } from '../api';
import {
  describeHandoffError,
  draftProblems,
  isPersonLine,
  noteGroups,
} from './format';

const apiError = (status: number, body: Record<string, unknown>) =>
  new ApiError(status, undefined, String(body.message ?? 'x'), undefined, body);

describe('noteGroups', () => {
  test('splits sections and marks the person lines', () => {
    const content = '## Goal\nShip it\n\n## Next\n1. a\n2. b';
    const groups = noteGroups(content, [{ from: 6, to: 6 }]);
    expect(groups.map((g) => g.heading)).toEqual(['Goal', 'Next']);
    expect(groups[0]?.lines.map((l) => l.text)).toEqual(['Ship it']);
    expect(groups[1]?.lines.map((l) => [l.text, l.person])).toEqual([
      ['1. a', false],
      ['2. b', true],
    ]);
  });

  test('a fenced ## is not a heading', () => {
    const groups = noteGroups('## Goal\n```\n## not\n```', []);
    expect(groups).toHaveLength(1);
  });
});

test('isPersonLine reads inclusive 1-based ranges', () => {
  expect(isPersonLine(3, [{ from: 3, to: 4 }])).toBe(true);
  expect(isPersonLine(5, [{ from: 3, to: 4 }])).toBe(false);
});

describe('describeHandoffError', () => {
  test('422 invalid_note lists every reason', () => {
    const failure = describeHandoffError(
      apiError(422, {
        error: 'invalid_note',
        message: 'a; b',
        reasons: [
          { code: 'x', message: 'a' },
          { code: 'y', message: 'b' },
        ],
      }),
    );
    expect(failure.reasons).toEqual(['a', 'b']);
  });

  test('409, 503 and 502 are told apart', () => {
    expect(describeHandoffError(apiError(409, {})).message).toContain(
      'worktree',
    );
    expect(describeHandoffError(apiError(503, {})).message).toContain(
      'offline or too old',
    );
    expect(
      describeHandoffError(apiError(502, { message: 'boom' })).message,
    ).toContain('boom');
  });
});

test('draftProblems flags an empty template', () => {
  expect(draftProblems(HANDOFF_NOTE_TEMPLATE).length).toBeGreaterThan(0);
  expect(
    draftProblems(
      HANDOFF_NOTE_TEMPLATE.replace('## Goal\n', '## Goal\nShip it\n'),
    ),
  ).toEqual([]);
});

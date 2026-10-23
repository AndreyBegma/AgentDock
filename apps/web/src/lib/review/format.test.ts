import { describe, expect, test } from 'bun:test';
import {
  type InstalledSkillView,
  REVIEW_ERROR,
  REVIEW_STEP_NAME_MAX,
} from '@nautelle/shared';
import { ApiError } from '../api';
import { step } from './fixtures';
import {
  describeReviewError,
  generationErrorText,
  inOrder,
  moveId,
  newStepRequest,
  skillOptions,
} from './format';

const skill = (invocation: string, runnable = true): InstalledSkillView =>
  ({ invocation, runnable }) as InstalledSkillView;

const refusal = (status: number, code: string, message = 'refused') =>
  new ApiError(status, code as ApiError['code'], message, undefined, {
    error: code,
  });

describe('review steps order (#890)', () => {
  test('moveId moves one id and leaves the rest in order', () => {
    expect(moveId(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a']);
    expect(moveId(['a', 'b', 'c'], 2, 1)).toEqual(['a', 'c', 'b']);
  });

  test('a move outside the list or onto itself changes nothing', () => {
    expect(moveId(['a', 'b'], 0, 0)).toEqual(['a', 'b']);
    expect(moveId(['a', 'b'], 0, 2)).toEqual(['a', 'b']);
    expect(moveId(['a', 'b'], -1, 1)).toEqual(['a', 'b']);
  });

  test('inOrder follows the ids and keeps a stray step at the end', () => {
    const steps = [step('a'), step('b'), step('c')];
    expect(inOrder(steps, ['c', 'a']).map((s) => s.id)).toEqual([
      'c',
      'a',
      'b',
    ]);
  });
});

describe('add step (#890)', () => {
  test('needs a skill and a name; the name is trimmed', () => {
    expect(newStepRequest('Security', null)).toBeNull();
    expect(newStepRequest('   ', 'cs-security')).toBeNull();
    expect(newStepRequest('  Security  ', 'cs-security')).toEqual({
      name: 'Security',
      skillName: 'cs-security',
    });
  });

  test('a name past the limit is cut to it', () => {
    const request = newStepRequest('x'.repeat(200), 'cs-security');
    expect(request?.name).toHaveLength(REVIEW_STEP_NAME_MAX);
  });

  test('the picker lists runnable skills once each, sorted', () => {
    expect(
      skillOptions([
        skill('cs-security'),
        skill('cs-review'),
        skill('cs-security'),
        skill('worker', false),
      ]),
    ).toEqual([
      { value: 'cs-review', label: 'cs-review' },
      { value: 'cs-security', label: 'cs-security' },
    ]);
  });
});

describe('review errors (#890)', () => {
  test('an unknown skill says what to do', () => {
    expect(
      describeReviewError(refusal(400, REVIEW_ERROR.unknownSkill)),
    ).toContain('does not report that skill');
  });

  test('generation failures are explained inline', () => {
    expect(describeReviewError(refusal(503, REVIEW_ERROR.noModel))).toContain(
      'AI providers',
    );
    expect(
      describeReviewError(refusal(502, REVIEW_ERROR.generationEmpty)),
    ).toContain('Try Regenerate again');
  });

  test('a 403 without a review code names the role needed', () => {
    expect(
      describeReviewError(new ApiError(403, undefined, 'Forbidden')),
    ).toContain('administrators');
  });

  test('a failed first generation keeps the default and offers Regenerate', () => {
    const text = generationErrorText({
      code: REVIEW_ERROR.runnerOffline,
      message: 'offline',
    });
    expect(text).toContain('built-in default');
    expect(text).toContain('runner is offline');
    expect(text).toContain('Regenerate');
  });
});

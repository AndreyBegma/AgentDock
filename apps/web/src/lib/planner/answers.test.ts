import { describe, expect, test } from 'bun:test';
import {
  acceptAllRecommendations,
  acceptRecommendation,
  answeredText,
  EMPTY_ROUND,
  isRecommended,
  pickOption,
  roundProblem,
  setAnswerText,
  toAnswers,
  toggleOption,
} from './answers';
import { question } from './fixtures';

const optionQ = question();
const wordsQ = question({
  id: 'q2',
  title: 'Name',
  options: [],
  recommendation: { text: 'Planner', why: 'It says what it does.' },
  blocking: false,
});
const round = [optionQ, wordsQ];

describe('question card answers', () => {
  test('accepting a recommendation picks its option, or takes its words', () => {
    const a = acceptRecommendation(EMPTY_ROUND, optionQ);
    expect(a.q1).toEqual({ optionId: 'db', text: '' });
    const b = acceptRecommendation(EMPTY_ROUND, wordsQ);
    expect(b.q2).toEqual({ text: 'Planner' });
    expect(isRecommended(a.q1, optionQ)).toBe(true);
    expect(isRecommended(b.q2, wordsQ)).toBe(true);
  });

  test('Accept all recommendations fills every card, over earlier answers', () => {
    const before = pickOption(EMPTY_ROUND, 'q1', 'gh');
    const all = acceptAllRecommendations(before, round);
    expect(toAnswers(all, round)).toEqual([
      { questionId: 'q1', optionId: 'db' },
      { questionId: 'q2', text: 'Planner' },
    ]);
  });

  test('another option or own words is not the recommendation', () => {
    const other = pickOption(EMPTY_ROUND, 'q1', 'gh');
    expect(isRecommended(other.q1, optionQ)).toBe(false);
    const words = setAnswerText(
      acceptRecommendation(EMPTY_ROUND, optionQ),
      'q1',
      'Both',
    );
    expect(isRecommended(words.q1, optionQ)).toBe(false);
  });

  test('the round is one list of answers, in question order, answered cards only', () => {
    let r = setAnswerText(EMPTY_ROUND, 'q2', '  Plans  ');
    r = pickOption(r, 'q1', 'gh');
    r = setAnswerText(r, 'q1', 'and a note');
    expect(toAnswers(r, round)).toEqual([
      { questionId: 'q1', optionId: 'gh', text: 'and a note' },
      { questionId: 'q2', text: 'Plans' },
    ]);
    expect(toAnswers(setAnswerText(EMPTY_ROUND, 'q2', '   '), round)).toEqual(
      [],
    );
  });

  test('a blocking card must be answered; a non-blocking one may stay empty', () => {
    expect(roundProblem(EMPTY_ROUND, round)).toBe('empty');
    expect(roundProblem(setAnswerText(EMPTY_ROUND, 'q2', 'x'), round)).toBe(
      'blocking',
    );
    expect(roundProblem(pickOption(EMPTY_ROUND, 'q1', 'gh'), round)).toBeNull();
    expect(
      roundProblem(setAnswerText(EMPTY_ROUND, 'q1', 'x'.repeat(4001)), round),
    ).toBe('too_long');
  });

  describe('multiple choice (#337 D3)', () => {
    const multiQ = question({
      id: 'q3',
      title: 'Platforms',
      multiple: true,
      options: [
        { id: 'web', label: 'Web' },
        { id: 'ios', label: 'iOS' },
        { id: 'android', label: 'Android' },
      ],
      recommendation: { optionId: 'web', text: 'Web', why: 'Most users.' },
      blocking: false,
    });

    test('accepts two options and sends optionIds, in the question order', () => {
      let r = toggleOption(EMPTY_ROUND, multiQ, 'android', true);
      r = toggleOption(r, multiQ, 'web', true);
      expect(toAnswers(r, [multiQ])).toEqual([
        { questionId: 'q3', optionIds: ['web', 'android'] },
      ]);
      expect(roundProblem(r, [multiQ])).toBeNull();
    });

    test('unchecking the last option leaves the card unanswered', () => {
      let r = toggleOption(EMPTY_ROUND, multiQ, 'ios', true);
      r = toggleOption(r, multiQ, 'ios', false);
      expect(toAnswers(r, [multiQ])).toEqual([]);
    });

    test('the free answer goes with the picks, or alone', () => {
      let r = toggleOption(EMPTY_ROUND, multiQ, 'ios', true);
      r = setAnswerText(r, 'q3', 'tablets too');
      expect(toAnswers(r, [multiQ])).toEqual([
        { questionId: 'q3', optionIds: ['ios'], text: 'tablets too' },
      ]);
      const words = setAnswerText(EMPTY_ROUND, 'q3', 'desktop only');
      expect(toAnswers(words, [multiQ])).toEqual([
        { questionId: 'q3', text: 'desktop only' },
      ]);
    });

    test('accepting the recommendation checks its one option', () => {
      const r = acceptRecommendation(EMPTY_ROUND, multiQ);
      expect(toAnswers(r, [multiQ])).toEqual([
        { questionId: 'q3', optionIds: ['web'] },
      ]);
      expect(isRecommended(r.q3, multiQ)).toBe(true);
      expect(
        isRecommended(toggleOption(r, multiQ, 'ios', true).q3, multiQ),
      ).toBe(false);
    });

    test('a single-choice question never sends optionIds', () => {
      const r = pickOption(EMPTY_ROUND, 'q1', 'gh');
      expect(toAnswers(r, [optionQ])[0]).toEqual({
        questionId: 'q1',
        optionId: 'gh',
      });
    });
  });

  test('counts what is answered', () => {
    expect(answeredText(pickOption(EMPTY_ROUND, 'q1', 'db'), round)).toBe(
      '1 of 2 answered',
    );
  });
});

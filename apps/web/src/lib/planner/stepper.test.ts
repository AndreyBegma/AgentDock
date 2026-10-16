import { describe, expect, test } from 'bun:test';
import { EMPTY_ROUND, pickOption, setAnswerText } from './answers';
import { question } from './fixtures';
import {
  clampStep,
  dotLabel,
  generateAnswers,
  generateProblem,
  stepDots,
  stepLabel,
} from './stepper';

const q1 = question();
const q2 = question({
  id: 'q2',
  title: 'Name',
  options: [],
  recommendation: { text: 'Planner', why: 'It says what it does.' },
  blocking: true,
});
const round = [q1, q2];

describe('the question stepper (#337 D3)', () => {
  test('says which question of how many, inside the round', () => {
    expect(stepLabel(0, 2)).toBe('Question 1 of 2');
    expect(stepLabel(5, 2)).toBe('Question 2 of 2');
    expect(clampStep(-1, 2)).toBe(0);
    expect(clampStep(3, 0)).toBe(0);
  });

  test('draws a dot per question, marking the answered and the current one', () => {
    const dots = stepDots(round, pickOption(EMPTY_ROUND, 'q1', 'gh'), 1);
    expect(dots.map((d) => [d.answered, d.current])).toEqual([
      [true, false],
      [false, true],
    ]);
    expect(dotLabel(dots[0] as (typeof dots)[number])).toBe(
      'Question 1, answered',
    );
  });

  test('Enough — generate sends the unanswered questions as their recommendations', () => {
    const r = setAnswerText(EMPTY_ROUND, 'q2', 'Board');
    expect(generateAnswers(r, round)).toEqual([
      { questionId: 'q1', optionId: 'db' },
      { questionId: 'q2', text: 'Board' },
    ]);
    // Blocking or not, nothing answered: all recommendations.
    expect(generateAnswers(EMPTY_ROUND, round)).toEqual([
      { questionId: 'q1', optionId: 'db' },
      { questionId: 'q2', text: 'Planner' },
    ]);
    // Before the first round: nothing to send.
    expect(generateAnswers(EMPTY_ROUND, [])).toEqual([]);
  });

  test('only an over-long answer stops Enough — generate', () => {
    expect(generateProblem(EMPTY_ROUND, round)).toBeNull();
    expect(
      generateProblem(
        setAnswerText(EMPTY_ROUND, 'q2', 'x'.repeat(4001)),
        round,
      ),
    ).not.toBeNull();
  });
});

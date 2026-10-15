import { describe, expect, test } from 'bun:test';
import type { PlanTurnView } from '@agentdock/shared';
import { question, turn } from './fixtures';
import { answerText, pastRounds, tookRecommendation } from './rounds';

const q1 = question();
const q2 = question({ id: 'q2', blocking: false });
const q3 = question({ id: 'q3' });
const at = (minute: number) =>
  `2026-10-13T10:${String(minute).padStart(2, '0')}:00.000Z`;

/** t2's round 1 from decompose, rounds 2 and 3 from grills; round 3 open. */
const threeRounds: PlanTurnView[] = [
  turn({
    id: 'decompose',
    createdAt: at(0),
    rounds: [
      { taskKey: 't2', questions: [q1] },
      { taskKey: 't3', questions: [q2] },
    ],
  }),
  turn({
    id: 'grill-1',
    taskKey: 't2',
    action: 'grill',
    createdAt: at(5),
    input: { answers: [{ questionId: 'q1', optionId: 'db' }] },
    rounds: [{ taskKey: 't2', questions: [q2] }],
  }),
  turn({
    id: 'grill-2',
    taskKey: 't2',
    action: 'grill',
    createdAt: at(10),
    input: { answers: [{ questionId: 'q2', text: 'Keep it local' }] },
    rounds: [{ taskKey: 't2', questions: [q3] }],
  }),
];

describe('past rounds', () => {
  test("pairs a task's rounds with the answers of the turn after them; the open one is not past", () => {
    const past = pastRounds(threeRounds, 't2');
    expect(
      past.map((r) => [
        r.openedBy.id,
        r.questions.map((q) => q.id),
        r.answeredBy?.id,
        Object.keys(r.answers),
      ]),
    ).toEqual([
      ['decompose', ['q1'], 'grill-1', ['q1']],
      ['grill-1', ['q2'], 'grill-2', ['q2']],
    ]);
  });

  test('scopes rounds to their task, and the plan level to clarify rounds', () => {
    expect(pastRounds(threeRounds, 't3')).toEqual([]);
    expect(pastRounds(threeRounds, null)).toEqual([]);
    const clarify = [
      turn({
        id: 'c1',
        action: 'clarify',
        rounds: [{ taskKey: null, questions: [q1] }],
      }),
      turn({
        id: 'c2',
        action: 'clarify',
        createdAt: at(3),
        input: { answers: [{ questionId: 'q1', optionId: 'gh' }] },
      }),
    ];
    expect(pastRounds(clarify, null).map((r) => r.answeredBy?.id)).toEqual([
      'c2',
    ]);
  });

  test('a failed or running answer keeps the round open', () => {
    const [decompose, grill] = threeRounds;
    for (const phase of ['failed', 'running'] as const) {
      // Such a turn has no output, so it opened no round either.
      const answer = { ...grill, phase, rounds: [] };
      expect(pastRounds([decompose, answer], 't2')).toEqual([]);
    }
  });

  test('a round replaced before an answer is past and unanswered', () => {
    const revise = turn({
      id: 'revise',
      action: 'revise',
      createdAt: at(2),
      rounds: [{ taskKey: 't2', questions: [q3] }],
    });
    const past = pastRounds([threeRounds[0], revise], 't2');
    expect(past).toHaveLength(1);
    expect(past[0]).toMatchObject({ answeredBy: null, answers: {} });
  });

  test('turns from an API before #184 carry no rounds and render none', () => {
    const old = { ...turn() } as Partial<PlanTurnView>;
    delete old.rounds;
    expect(pastRounds([old as PlanTurnView], null)).toEqual([]);
  });
});

describe('answer text', () => {
  test("reads an option by its label, then the person's words", () => {
    expect(answerText(q1, { questionId: 'q1', optionId: 'gh' })).toBe(
      'GitHub drafts',
    );
    expect(
      answerText(q1, { questionId: 'q1', optionId: 'db', text: 'for now' }),
    ).toBe('Database — for now');
    expect(answerText(q1, undefined)).toBeNull();
  });

  test('knows an accepted recommendation', () => {
    expect(tookRecommendation(q1, { questionId: 'q1', optionId: 'db' })).toBe(
      true,
    );
    expect(
      tookRecommendation(q1, { questionId: 'q1', optionId: 'db', text: 'x' }),
    ).toBe(false);
  });
});

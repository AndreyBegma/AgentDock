import type { PlanDetail, PlanQuestion } from '@nautelle/shared';
import { CALLBACK_DATA_MAX } from './callback-data';
import {
  chatAnswers,
  INTAKE_ACTION,
  INTAKE_DONE,
  INTAKE_OPTION,
  intakeChatPhase,
  phaseKey,
  pressOption,
  questionKeyboard,
} from './intake-chat';

const question = (multiple = false): PlanQuestion => ({
  id: 'q1',
  title: 'Fields',
  question: 'Which fields?',
  options: [
    { id: 'a', label: 'A' },
    { id: 'b', label: 'B' },
    { id: 'c', label: 'C' },
  ],
  ...(multiple ? { multiple: true } : {}),
  recommendation: { optionId: 'a', text: 'A', why: 'Simplest.' },
  blocking: false,
});

const plan = (over: Partial<PlanDetail>): PlanDetail =>
  ({
    status: 'clarifying',
    activeTurnId: null,
    turns: [],
    questions: [],
    intake: { roundsAsked: 0, maxRounds: 4, split: null },
    ...over,
  }) as PlanDetail;

const turn = (id: string, phase: string, taskKey: string | null = null) =>
  ({ id, phase, taskKey }) as PlanDetail['turns'][number];

describe('intake chat (#574)', () => {
  it('keeps every button under Telegram’s 64 bytes', () => {
    for (const codec of [INTAKE_OPTION, INTAKE_DONE, INTAKE_ACTION]) {
      expect(codec.maxBytes).toBeLessThanOrEqual(CALLBACK_DATA_MAX);
    }
    const planId = 'c'.repeat(25);
    expect(
      INTAKE_OPTION.decode(INTAKE_OPTION.encode({ plan: planId, option: 2 })),
    ).toEqual({ plan: planId, option: 2 });
  });

  it('takes one option on a single-choice question, replacing an own answer', () => {
    const q = question();
    const typed = { q1: { text: 'Mine' } };
    expect(pressOption(typed, q, 1)).toEqual({ q1: { optionId: 'b' } });
    expect(pressOption({}, q, 9)).toBeNull();
  });

  it('toggles options of a multiple-choice question in the question’s order', () => {
    const q = question(true);
    const one = pressOption({}, q, 2);
    const two = pressOption(one ?? {}, q, 0);
    expect(two).toEqual({ q1: { optionIds: ['a', 'c'] } });
    const back = pressOption(pressOption(two ?? {}, q, 0) ?? {}, q, 2);
    expect(back).toEqual({});
  });

  it('turns the chat’s answers into a turn’s, in round order', () => {
    const q2 = { ...question(true), id: 'q2' };
    expect(
      chatAnswers([question(), q2], {
        q2: { optionIds: ['b'] },
        q1: { text: 'Own words' },
      }),
    ).toEqual([
      { questionId: 'q1', text: 'Own words' },
      { questionId: 'q2', optionIds: ['b'] },
    ]);
  });

  it('marks the picks and the recommendation, with Done on a multiple', () => {
    const rows = questionKeyboard('p1', question(true), { optionIds: ['b'] });
    expect(rows.flat().map((b) => b.text)).toEqual(['A ★', '✓ B', 'C', 'Done']);
  });

  it('reads the phase as the web does', () => {
    expect(intakeChatPhase(plan({ activeTurnId: 't2' }))).toEqual({
      kind: 'thinking',
      turnId: 't2',
    });
    expect(
      intakeChatPhase(
        plan({ turns: [turn('t1', 'succeeded'), turn('t2', 'failed')] }),
      ),
    ).toEqual({ kind: 'failed', turnId: 't2' });
    const round = intakeChatPhase(
      plan({
        turns: [turn('t1', 'succeeded')],
        questions: [question()],
        intake: { roundsAsked: 2, maxRounds: 4 },
      }),
    );
    expect(phaseKey(round)).toBe('round:t1');
    expect(intakeChatPhase(plan({ status: 'done' }))).toEqual({ kind: 'done' });
    // #592: candidates wait in Drafts.
    expect(intakeChatPhase(plan({ status: 'reviewing' }))).toEqual({
      kind: 'review',
      candidates: [],
    });
    expect(intakeChatPhase(plan({ status: 'archived' }))).toEqual({
      kind: 'closed',
    });
    expect(
      phaseKey(intakeChatPhase(plan({ turns: [turn('t1', 'cancelled')] }))),
    ).toBe('idle:t1');
  });
});

import { describe, expect, it } from 'bun:test';
import { cardAssessAnswerSchema } from './contract';
import { CARD_ASSESS_REASON_MAX, cardAssessJobId } from './limits';

const answer = {
  work: {
    model: 'sonnet',
    effort: 'low',
    class: 'mechanical',
    signals: [],
    reason: 'Executes a clear, single-module change.',
  },
  design: { model: 'opus', reason: 'The layout is still undecided.' },
} as const;

const parse = (value: unknown) => cardAssessAnswerSchema.safeParse(value);

describe('cardAssessAnswerSchema (D6)', () => {
  it('accepts the contract', () => {
    const parsed = parse(answer);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toEqual(answer);
  });

  it('recommends opus, sonnet or haiku for work — never fable (A1)', () => {
    for (const model of ['opus', 'sonnet', 'haiku']) {
      expect(
        parse({ ...answer, work: { ...answer.work, model } }).success,
      ).toBe(true);
    }
    for (const model of ['fable', 'claude-opus-5-5', 'Opus', '']) {
      expect(
        parse({ ...answer, work: { ...answer.work, model } }).success,
      ).toBe(false);
    }
  });

  it('recommends a low, medium or high effort for work only (#663)', () => {
    for (const effort of ['low', 'medium', 'high']) {
      expect(
        parse({ ...answer, work: { ...answer.work, effort } }).success,
      ).toBe(true);
    }
    for (const effort of ['xhigh', 'max', 'Low', '']) {
      expect(
        parse({ ...answer, work: { ...answer.work, effort } }).success,
      ).toBe(false);
    }
    const { effort: _, ...noEffort } = answer.work;
    expect(parse({ ...answer, work: noEffort }).success).toBe(false);
    expect(
      parse({ ...answer, design: { ...answer.design, effort: 'low' } }).success,
    ).toBe(false);
  });

  it('classifies the work, with the deciding signals it found (#750 D1, D2)', () => {
    for (const workClass of ['mechanical', 'deciding', 'unsure']) {
      expect(
        parse({ ...answer, work: { ...answer.work, class: workClass } })
          .success,
      ).toBe(true);
    }
    expect(
      parse({ ...answer, work: { ...answer.work, class: 'trivial' } }).success,
    ).toBe(false);
    const withSignals = (signals: unknown) =>
      parse({ ...answer, work: { ...answer.work, signals } }).success;
    expect(withSignals(['auth'])).toBe(true);
    expect(
      withSignals([
        'schema',
        'auth',
        'tenancy',
        'payments',
        'deletion',
        'bug_cause_unknown',
        'no_precedent',
      ]),
    ).toBe(true);
    expect(withSignals(['auth', 'auth'])).toBe(false);
    expect(withSignals(['security'])).toBe(false);
    expect(withSignals('auth')).toBe(false);
  });

  it('is out of contract without class or signals (#750 D1)', () => {
    const { class: _, ...noClass } = answer.work;
    expect(parse({ ...answer, work: noClass }).success).toBe(false);
    const { signals: __, ...noSignals } = answer.work;
    expect(parse({ ...answer, work: noSignals }).success).toBe(false);
  });

  it('chooses between opus and sonnet only for design', () => {
    expect(
      parse({ ...answer, design: { ...answer.design, model: 'sonnet' } })
        .success,
    ).toBe(true);
    expect(
      parse({ ...answer, design: { ...answer.design, model: 'haiku' } })
        .success,
    ).toBe(false);
  });

  it('bounds the reason to one line of 160 characters', () => {
    const withReason = (reason: string) =>
      parse({ ...answer, work: { ...answer.work, reason } }).success;
    expect(withReason('x'.repeat(CARD_ASSESS_REASON_MAX))).toBe(true);
    expect(withReason('x'.repeat(CARD_ASSESS_REASON_MAX + 1))).toBe(false);
    expect(withReason('   ')).toBe(false);
    expect(withReason('two\nlines')).toBe(false);
  });

  it('refuses another shape', () => {
    expect(parse({ work: answer.work }).success).toBe(false);
    expect(parse({ ...answer, effort: 'high' }).success).toBe(false);
    expect(
      parse({ ...answer, work: { ...answer.work, confidence: 0.9 } }).success,
    ).toBe(false);
    expect(parse('sonnet').success).toBe(false);
    expect(parse(null).success).toBe(false);
  });
});

describe('cardAssessJobId', () => {
  it('has no single colon (BullMQ 5)', () => {
    expect(cardAssessJobId('c1', 'abc')).toBe('card-assess-c1-abc');
  });
});

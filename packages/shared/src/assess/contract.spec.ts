import { describe, expect, it } from 'bun:test';
import { cardAssessAnswerSchema } from './contract';
import { CARD_ASSESS_REASON_MAX, cardAssessJobId } from './limits';

const answer = {
  work: { model: 'sonnet', reason: 'Executes a clear, single-module change.' },
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

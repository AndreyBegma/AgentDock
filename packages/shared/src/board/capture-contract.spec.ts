import { describe, expect, it } from 'bun:test';
import {
  type CaptureSuggestion,
  type CaptureViolation,
  parseCaptureOutput,
  selectCaptureCards,
} from './capture-contract';
import { captureFingerprint } from './capture-fingerprint';

const card = (over: Record<string, unknown> = {}) => ({
  title: 'Fix the login redirect loop',
  body: 'After logout the app redirects forever.',
  kind: 'bug',
  why: 'The developer saw the loop and deferred it.',
  confidence: 0.8,
  evidence: [101],
  ...over,
});

const block = (value: unknown): string =>
  `Here are the tasks.\n\n\`\`\`agentdock-cards\n${JSON.stringify(value)}\n\`\`\`\n`;

const INPUT = ['101', '104', '230'];

describe('parseCaptureOutput', () => {
  it('accepts one block and normalizes evidence ids to distinct strings', () => {
    const result = parseCaptureOutput(
      block({ cards: [card({ evidence: [101, '104', 101] })] }),
      INPUT,
    );
    expect(result).toEqual({
      ok: true,
      cards: [
        {
          title: 'Fix the login redirect loop',
          body: 'After logout the app redirects forever.',
          kind: 'bug',
          why: 'The developer saw the loop and deferred it.',
          confidence: 0.8,
          evidence: ['101', '104'],
        },
      ],
    });
  });

  it('accepts an empty proposal', () => {
    expect(parseCaptureOutput(block({ cards: [] }), INPUT)).toEqual({
      ok: true,
      cards: [],
    });
  });

  it('takes BigInt input ids', () => {
    expect(parseCaptureOutput(block({ cards: [card()] }), [101n]).ok).toBe(
      true,
    );
  });

  const violates = (text: string, reason: CaptureViolation) => {
    const result = parseCaptureOutput(text, INPUT);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('contract_violation');
      expect(result.reason).toBe(reason);
    }
  };

  it('refuses more than five cards', () => {
    violates(
      block({
        cards: Array.from({ length: 6 }, (_, i) =>
          card({ title: `Task ${i}` }),
        ),
      }),
      'too_many_cards',
    );
  });

  it('refuses an evidence id that was not in the input', () => {
    violates(
      block({ cards: [card({ evidence: [101, 999] })] }),
      'unknown_evidence',
    );
  });

  it('refuses two blocks', () => {
    violates(block({ cards: [] }) + block({ cards: [] }), 'multiple_blocks');
  });

  it('refuses no block, an unclosed block and bad JSON', () => {
    violates('{"cards": []}', 'no_block');
    violates('```json\n{"cards": []}\n```', 'no_block');
    violates('```agentdock-cards\n{"cards": []}\n', 'unterminated_block');
    violates('```agentdock-cards\n{cards: []}\n```', 'invalid_json');
  });

  it('refuses a card out of range, an unknown field or a wrong kind', () => {
    for (const over of [
      { title: 'x'.repeat(121) },
      { title: 'two\nlines' },
      { title: '!!!' },
      { body: 'x'.repeat(2001) },
      { why: '' },
      { why: 'x'.repeat(301) },
      { kind: 'chore' },
      { confidence: 1.2 },
      { confidence: -0.1 },
      { evidence: [] },
      { evidence: [101, 104, 230, 231, 232, 233] },
      { evidence: [-1] },
      { evidence: ['1e3'] },
      { label: 'extra' },
    ]) {
      violates(block({ cards: [card(over)] }), 'invalid_card');
    }
    violates(block({ cards: [card()], extra: true }), 'invalid_card');
  });

  it('never quotes the offending value in its message', () => {
    const result = parseCaptureOutput(
      block({ cards: [card({ kind: 'secret-sk-abc123' })] }),
      INPUT,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).not.toContain('sk-abc123');
  });
});

describe('selectCaptureCards', () => {
  const suggestion = (title: string, confidence = 0.8): CaptureSuggestion => ({
    title,
    body: '',
    kind: 'feature',
    why: 'why',
    confidence,
    evidence: ['101'],
  });

  it('drops a suggestion below 0.6 confidence', () => {
    const { kept, dropped } = selectCaptureCards(
      [suggestion('Add dark mode', 0.5), suggestion('Add export', 0.6)],
      new Set(),
    );
    expect(kept.map((c) => c.title)).toEqual(['Add export']);
    expect(dropped).toEqual([
      {
        fingerprint: captureFingerprint('Add dark mode'),
        reason: 'low_confidence',
      },
    ]);
  });

  it('drops a fingerprint the project already knows', () => {
    const known = new Set([captureFingerprint('add dark-mode')]);
    const { kept, dropped } = selectCaptureCards(
      [suggestion('Add dark mode!')],
      known,
    );
    expect(kept).toEqual([]);
    expect(dropped[0].reason).toBe('known');
  });

  it('collapses duplicates of one result to the most confident, in first place', () => {
    const { kept, dropped } = selectCaptureCards(
      [
        suggestion('Add export', 0.7),
        suggestion('Fix login', 0.9),
        suggestion('add  EXPORT.', 0.95),
      ],
      new Set(),
    );
    expect(kept.map((c) => [c.title, c.confidence])).toEqual([
      ['add  EXPORT.', 0.95],
      ['Fix login', 0.9],
    ]);
    expect(kept[0].fingerprint).toBe(captureFingerprint('Add export'));
    expect(dropped.map((d) => d.reason)).toEqual(['duplicate']);
  });
});

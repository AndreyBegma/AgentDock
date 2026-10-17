import { describe, expect, it } from 'bun:test';
import { buildCapturePrompt } from './capture-prompt';
import {
  type CardWorkerPromptInput,
  cardCiFixPrompt,
  cardFeedbackPrompt,
  cardNextRoundPrompt,
  cardWorkerPrompt,
} from './worker-prompt';

/**
 * C-254: every launch prompt has a token budget (bytes ÷ 4) and keeps its
 * static instructions first, so the prompt cache reuses the prefix across
 * runs. A prompt that outgrows its budget fails here; raise a budget only on
 * purpose, in the change that explains why the prompt grew.
 */
const tokens = (text: string): number =>
  Math.ceil(new TextEncoder().encode(text).length / 4);

const commonPrefix = (a: string, b: string): number => {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  return i;
};

const card: CardWorkerPromptInput = {
  number: 12,
  title: 'Add login',
  body: 'Users sign in with a password.',
  kind: 'feature',
  branch: 'card/c12-add-login',
  base: 'develop',
  specPath: 'docs/specs/card-12-add-login.md',
  issueNumber: 7,
  design: null,
};

const other: CardWorkerPromptInput = {
  ...card,
  number: 99,
  title: 'Fix the export',
  body: 'The CSV export drops the last row.',
  kind: 'bug',
  branch: 'card/c99-fix-the-export',
  specPath: 'docs/specs/card-99-fix-the-export.md',
  issueNumber: 41,
};

describe('prompt budgets — the card worker (C-254)', () => {
  it('the round 1 prompt stays within its budget', () => {
    expect(tokens(cardWorkerPrompt(card))).toBeLessThanOrEqual(700);
  });

  it('the round 1 prompt with Token saver stays within its budget', () => {
    expect(
      tokens(cardWorkerPrompt({ ...card, tokenSaver: true })),
    ).toBeLessThanOrEqual(1100);
  });

  it('the follow-up round prompts stay within their budgets', () => {
    expect(
      tokens(cardFeedbackPrompt('Rename the button.')),
    ).toBeLessThanOrEqual(50);
    expect(
      tokens(cardCiFixPrompt({ reason: 'conflict', base: 'develop' })),
    ).toBeLessThanOrEqual(100);
    expect(
      tokens(
        cardCiFixPrompt({
          reason: 'red',
          headSha: 'a'.repeat(40),
          failed: [{ name: 'lint', link: null }],
          checks: null,
        }),
      ),
    ).toBeLessThanOrEqual(100);
    expect(
      tokens(
        cardNextRoundPrompt({ label: 'C-12', change: null, feedback: null }),
      ),
    ).toBeLessThanOrEqual(5);
  });

  it('keeps everything per card after the static instructions', () => {
    for (const tokenSaver of [false, true]) {
      const a = cardWorkerPrompt({ ...card, tokenSaver });
      const b = cardWorkerPrompt({ ...other, tokenSaver });
      const shared = a.slice(0, commonPrefix(a, b));
      // The prefix reaches the card's heading: instructions only.
      expect(shared).toContain('## When you are done');
      expect(shared.endsWith('## Card C-')).toBe(true);
      for (const value of ['Add login', 'c12', 'develop', 'docs/specs', '#7']) {
        expect(shared).not.toContain(value);
      }
    }
  });
});

describe('prompt budgets — capture (C-254)', () => {
  const prompt = (id: string, text: string) =>
    buildCapturePrompt([{ id, kind: 'prompt', text, clipped: false }], [text]);

  it('stays within its budget', () => {
    expect(tokens(buildCapturePrompt([], []))).toBeLessThanOrEqual(400);
  });

  it('puts the instructions before the open cards and the session', () => {
    const a = prompt('1', 'rename the quokka table');
    const b = prompt('2', 'drop the zebra column');
    const shared = a.slice(0, commonPrefix(a, b));
    expect(shared).toContain('Open cards on the board:');
    expect(shared).not.toContain('quokka');
  });
});

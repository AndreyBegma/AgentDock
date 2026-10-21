import { describe, expect, it } from 'bun:test';
import { CARD_RUN_PROMPT_MAX_BYTES } from '@nautelle/shared/protocol';
import {
  acceptanceChecklist,
  freshSeed,
  NO_CARD_PROMPT_TEXT,
  type SeedInput,
} from './seed';
import { cardNumberOfPrompt } from './state';
import { validNote } from './testing';

const input: SeedInput = {
  cardPrompt: '## Card C-12: Add login\n\nBuild it.',
  note: validNote(),
  diff: { stat: ' login.ts | 3 +++', full: '+export const login = 1;' },
  checklist: '- [ ] the form submits',
  roundPrompt: 'continue',
  previousSessionId: '11111111-1111-4111-8111-111111111111',
};

describe('the fresh seed (#449 D3)', () => {
  it('holds the card prompt, the note, the diff, the checklist and the round', () => {
    const seed = freshSeed(input) ?? '';
    const order = [
      '## Card C-12: Add login',
      '<handoff-note>',
      '## Goal',
      'login.ts | 3 +++',
      '+export const login = 1;',
      '- [ ] the form submits',
      '## This round',
      'continue',
    ].map((part) => seed.indexOf(part));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(seed).toContain(input.previousSessionId);
  });

  it('drops the full diff first, then the stat, never the note', () => {
    const big = 'x'.repeat(CARD_RUN_PROMPT_MAX_BYTES - 15_000);
    const seed = freshSeed({
      ...input,
      cardPrompt: big,
      diff: { stat: 's'.repeat(2_000), full: 'f'.repeat(20_000) },
    });
    expect(seed).not.toBeNull();
    expect(seed).not.toContain('fffff');
    expect(seed).toContain('sssss');
    expect(seed).toContain('## Goal');
  });

  it('is null when the card prompt and the note alone do not fit', () => {
    expect(
      freshSeed({
        ...input,
        cardPrompt: 'x'.repeat(CARD_RUN_PROMPT_MAX_BYTES),
      }),
    ).toBeNull();
  });

  it('#750 D7: says why — the cost, or a changed model or effort', () => {
    expect(freshSeed(input)).toContain('resuming it would have cost more');
    const changed = freshSeed({ ...input, reason: 'changed' }) ?? '';
    expect(changed).toContain('the model or effort changed');
    expect(changed).not.toContain('cost more');
  });

  it('#750 D7: the reduced seed — no kept card prompt, no note — still carries the branch, the checklist and the round', () => {
    const seed =
      freshSeed({
        ...input,
        cardPrompt: null,
        note: null,
        reason: 'changed',
      }) ?? '';
    expect(seed.startsWith(NO_CARD_PROMPT_TEXT)).toBe(true);
    expect(seed).not.toContain('<handoff-note>');
    expect(seed).toContain('No handoff note was kept');
    expect(seed).toContain('login.ts | 3 +++');
    expect(seed).toContain('- [ ] the form submits');
    expect(seed.trimEnd().endsWith('continue')).toBe(true);
    // A kept card prompt without a note keeps the card.
    const withCard = freshSeed({ ...input, note: null }) ?? '';
    expect(withCard.startsWith('## Card C-12: Add login')).toBe(true);
    expect(withCard).toContain('No handoff note was kept');
  });

  it('takes the PR description’s acceptance checklist', () => {
    expect(
      acceptanceChecklist(
        'Closes #4\n\n## What changed and why\n\nx\n\n## Acceptance criteria\n\n- [x] a\n- [ ] b\n\n## Notes\n\nn',
      ),
    ).toBe('- [x] a\n- [ ] b');
    expect(acceptanceChecklist('## What changed\n\nx')).toBe('');
    expect(acceptanceChecklist(null)).toBe('');
  });

  it('reads the card number from round 1’s header', () => {
    expect(cardNumberOfPrompt('intro\n\n## Card C-12: Add login\n')).toBe(12);
    expect(cardNumberOfPrompt('intro\n\n## Card C-12\n\nKind: bug')).toBe(12);
    expect(cardNumberOfPrompt('continue')).toBeNull();
  });
});

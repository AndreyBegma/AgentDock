import {
  cardWorkerPrompt,
  ESCALATE_CARD_TOOL,
  TERSE_REGISTER,
} from '@nautelle/shared';
import { CARD_RUN_PROMPT_MAX_BYTES } from '@nautelle/shared/protocol';
import {
  cardPromptEscalate,
  cardPromptSaver,
  escalationRoundPrompt,
} from './board-rounds.service';

const card = {
  number: 12,
  title: 'Add login',
  body: 'Users sign in with a password.',
  kind: 'feature' as const,
  branch: 'card/c12-add-login',
  base: 'develop',
  specPath: null,
  issueNumber: 7,
  design: null,
};

describe('cardPromptSaver (#747)', () => {
  it('gives the round-1 prompt the Token saver lines when the launch has it on', () => {
    expect(cardPromptSaver({ on: true, techniques: null })).toEqual({
      tokenSaver: true,
    });
    const prompt = cardWorkerPrompt({
      ...card,
      ...cardPromptSaver({ on: true, techniques: null }),
    });
    expect(prompt).toContain('use the `scout` subagent');
    expect(prompt).toContain('## Handoff note');
    expect(
      cardWorkerPrompt({
        ...card,
        ...cardPromptSaver({ on: false, techniques: null }),
      }),
    ).not.toContain('## Handoff note');
  });

  it('passes the terse-register arm only when the flags are launched (D10)', () => {
    expect(
      cardPromptSaver({ on: true, techniques: { 'terse-register': false } }),
    ).toEqual({ tokenSaver: true, terseRegister: false });
    expect(
      cardPromptSaver({ on: true, techniques: { 'terse-register': true } }),
    ).toEqual({ tokenSaver: true, terseRegister: true });
    // A runner without tokenEconomy: no snapshot, no arm — the register is on.
    expect(cardPromptSaver({ on: true, techniques: {} })).toEqual({
      tokenSaver: true,
    });
  });

  it('the control arm reaches the prompt without the terse register', () => {
    const control = cardWorkerPrompt({
      ...card,
      ...cardPromptSaver({
        on: true,
        techniques: { 'terse-register': false },
      }),
    });
    expect(control).not.toContain(TERSE_REGISTER);
    expect(control).toContain('- Audience register — what a person reads');
    expect(
      cardWorkerPrompt({
        ...card,
        ...cardPromptSaver({ on: true, techniques: null }),
      }),
    ).toContain(TERSE_REGISTER);
  });
});

describe('cardPromptEscalate (#750 D8)', () => {
  it('puts the escalate_card text in the round-1 prompt only when the tool is offered', () => {
    expect(cardPromptEscalate(false)).toEqual({});
    expect(
      cardWorkerPrompt({ ...card, ...cardPromptEscalate(true) }),
    ).toContain(ESCALATE_CARD_TOOL);
    expect(
      cardWorkerPrompt({ ...card, ...cardPromptEscalate(false) }),
    ).not.toContain(ESCALATE_CARD_TOOL);
  });
});

describe('escalationRoundPrompt (#750 D9)', () => {
  const escalated = {
    escalationReason: 'misclassified' as const,
    escalationNote: 'The card needs a schema decision.',
    sessionModel: 'sonnet',
  };

  it('adds the previous worker’s finding to the next-round prompt', () => {
    const prompt = escalationRoundPrompt(escalated, 'continue', 'continue');
    expect(prompt.startsWith('continue\n\n')).toBe(true);
    expect(prompt).toContain('reason `misclassified`');
    expect(prompt).toContain('(on `sonnet`)');
    expect(prompt).toContain('The card needs a schema decision.');
  });

  it('falls back to the plain prompt when the change leaves no room', () => {
    const huge = 'x'.repeat(CARD_RUN_PROMPT_MAX_BYTES);
    const prompt = escalationRoundPrompt(escalated, huge, 'continue');
    expect(prompt.startsWith('continue\n\n')).toBe(true);
    expect(prompt).toContain('The card needs a schema decision.');
  });

  it('is the next-round prompt for a card with no escalation', () => {
    expect(
      escalationRoundPrompt(
        { escalationReason: null, escalationNote: null, sessionModel: null },
        'continue',
        'continue',
      ),
    ).toBe('continue');
  });
});

import { cardWorkerPrompt, TERSE_REGISTER } from '@nautelle/shared';
import { cardPromptSaver } from './board-rounds.service';

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

import type { SessionMessageOutcome } from '@nautelle/shared';
import { answerSteps, readQuestion } from '../cards/question';
import type { TmuxControl } from '../control/tmux';
import { readPane } from '../steward/pane-rules';

/** The tmux calls delivery makes — `TmuxControl`'s, exact-target each. */
export type DeliveryTmux = Pick<
  TmuxControl,
  'capture' | 'sendLiteral' | 'sendSubmit' | 'sendKey'
>;

/**
 * #489, #447: the one path text reaches a Claude Code session — Steward's
 * nudge, the trailer guard's notice and a person's message. The pane is
 * read first: the text goes in with `send-keys -l`, then `C-m` in a call of
 * its own (#189), only at an input box. `idleOnly` (Steward) types at an
 * empty, idle prompt alone; a person's message is also typed while the
 * agent works, and Claude Code queues it for its next step (M3). A question
 * selector, a dialog or a permission prompt gets nothing.
 */
export const deliverText = async (
  tmux: DeliveryTmux,
  session: string,
  text: string,
  options: { idleOnly?: boolean } = {},
): Promise<SessionMessageOutcome> => {
  const pane = await tmux.capture(session);
  if (pane === null) return 'no_session';
  const { state } = readPane(pane);
  if (state === 'question') return 'question';
  if (state !== 'idle' && (options.idleOnly || state !== 'busy')) {
    return 'not_at_input';
  }
  await tmux.sendLiteral(session, text);
  await tmux.sendSubmit(session);
  return 'sent';
};

/**
 * #489 M4: answers the question selector the pane shows — the option with
 * that number, or typed text in its "Other" field — with the keys
 * `answerSteps` fixes, only while the pane still shows the screen
 * `questionKey` names.
 */
export const answerQuestion = async (
  tmux: DeliveryTmux,
  session: string,
  questionKey: string,
  answer: { index: number } | { text: string },
): Promise<SessionMessageOutcome> => {
  const pane = await tmux.capture(session);
  if (pane === null) return 'no_session';
  if (readPane(pane).state !== 'question') return 'question_changed';
  const screen = readQuestion(pane);
  if (!screen || screen.question.key !== questionKey) {
    return 'question_changed';
  }
  const steps = answerSteps(screen, answer);
  if (!steps) return 'no_option';
  for (const step of steps) {
    if ('literal' in step) await tmux.sendLiteral(session, step.literal);
    else await tmux.sendKey(session, step.key);
  }
  return 'answered';
};

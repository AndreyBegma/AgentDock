import {
  cleanSessionMessage,
  SESSION_MESSAGE_MAX_CHARS,
  type SessionMessageOutcome,
} from '@agentdock/shared';
import { ApiError } from '../api';

/** What became of a message, as the line under the composer says it. */
export const SESSION_MESSAGE_OUTCOME: Record<
  SessionMessageOutcome,
  { tone: 'ok' | 'warn'; text: string }
> = {
  sent: {
    tone: 'ok',
    text: 'Sent. If the agent is working, it reads it at its next step.',
  },
  answered: { tone: 'ok', text: 'Answered.' },
  no_session: { tone: 'warn', text: 'The session is gone; nothing was sent.' },
  question: {
    tone: 'warn',
    text: 'The session shows a question; pick an option or answer it with Other.',
  },
  question_changed: {
    tone: 'warn',
    text: 'The question has changed or is gone; nothing was sent.',
  },
  not_at_input: {
    tone: 'warn',
    text: 'The session shows a dialog or a permission prompt; nothing was sent.',
  },
  no_option: {
    tone: 'warn',
    text: 'That option is not offered any more; nothing was sent.',
  },
};

/**
 * Why a draft cannot be sent yet: nothing left once control characters are
 * removed, or over the cap. Null when it can.
 */
export const draftProblem = (draft: string): 'empty' | 'too_long' | null => {
  if (Array.from(draft).length > SESSION_MESSAGE_MAX_CHARS) return 'too_long';
  return cleanSessionMessage(draft).length === 0 ? 'empty' : null;
};

const ERRORS: Record<string, string> = {
  invalid_message: 'Nothing is left of that message once cleaned.',
  not_running: 'The session is not running any more.',
  command_unavailable:
    'The runner is offline or cannot take messages; update it.',
  runner_timeout: 'The runner did not answer in time; it may have arrived.',
  forbidden: 'Messaging a session needs the operator role.',
};

/** A failed send, said plainly. */
export const sessionMessageError = (error: unknown): string => {
  if (error instanceof ApiError) {
    if (error.status === 403) return ERRORS.forbidden ?? error.message;
    const code =
      typeof error.body?.error === 'string' ? error.body.error : undefined;
    return (code && ERRORS[code]) ?? error.message;
  }
  return error instanceof Error ? error.message : 'The message was not sent.';
};

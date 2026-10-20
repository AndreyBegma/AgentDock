import type {
  PendingQuestion,
  SessionMessageErrorCode,
  SessionMessageOutcome,
} from '@agentdock/shared';
import { escapeMarkdownV2 } from './markdown-v2';
import type { InlineKeyboardButton } from './telegram-client';

/**
 * #489 M2: a card's `card.waiting` message on Telegram — one button per
 * option of the question its session shows, and a reply to the message as
 * text for the session — and the bot's fixed answers. Pure:
 * `TelegramSessionMessageService` does the checks and the calls.
 */

export interface SessionOptionPress {
  /** The `card.waiting` notification the message was sent for. */
  notificationId: bigint;
  questionKey: string;
  index: number;
}

/** `q:<notification id>:<question key>:<option number>`, ≤ 64 bytes. */
const CALLBACK = /^q:(\d{1,19}):([0-9a-f]{16}):(\d{1,2})$/;
/** The message's last line: `Ref card <notification id>`. */
const REFERENCE = /^Ref card (\d{1,19})$/m;
/** A button's label, cut to what Telegram shows comfortably. */
const LABEL_MAX = 60;
const QUESTION_MAX = 600;

const clip = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

export const encodeSessionOptionCallback = (press: SessionOptionPress) =>
  `q:${press.notificationId}:${press.questionKey}:${press.index}`;

/** Null for anything that is not a question option button. */
export const decodeSessionOptionCallback = (
  data: string | undefined,
): SessionOptionPress | null => {
  const match = data ? CALLBACK.exec(data) : null;
  if (!match) return null;
  return {
    notificationId: BigInt(match[1] ?? '0'),
    questionKey: match[2] ?? '',
    index: Number(match[3]),
  };
};

/** Whether a callback belongs to the question option buttons (`q:`). */
export const isSessionOptionCallback = (data: string | undefined): boolean =>
  typeof data === 'string' && data.startsWith('q:');

/** One button per option, each on its own row. */
export const questionKeyboard = (
  notificationId: bigint,
  question: PendingQuestion,
): InlineKeyboardButton[][] =>
  question.options.map((option) => [
    {
      text: clip(`${option.index}. ${option.label}`, LABEL_MAX),
      callback_data: encodeSessionOptionCallback({
        notificationId,
        questionKey: question.key,
        index: option.index,
      }),
    },
  ]);

/**
 * The lines added under a `card.waiting` message, MarkdownV2: the question
 * when one is up, how to reply, and the reference a reply is matched by.
 */
export const sessionReplyFooter = (
  notificationId: bigint,
  question: PendingQuestion | null,
): string =>
  [
    '',
    ...(question
      ? [
          escapeMarkdownV2(clip(question.text, QUESTION_MAX)),
          escapeMarkdownV2(
            question.other
              ? 'Press an option, or reply to this message with your own answer.'
              : 'Press an option.',
          ),
        ]
      : [
          escapeMarkdownV2(
            'Reply to this message to send its worker a message.',
          ),
        ]),
    escapeMarkdownV2(`Ref card ${notificationId}`),
  ].join('\n');

/** The notification a reply's prompt names; null for any other text. */
export const parseSessionReference = (
  text: string | undefined,
): bigint | null => {
  const match = text ? REFERENCE.exec(text) : null;
  return match ? BigInt(match[1] ?? '0') : null;
};

/** Why a press or a reply was refused before the message was sent. */
export type SessionRefusal =
  | 'invalid_button'
  | 'not_linked'
  | 'unknown_message'
  | 'inactive_user'
  | 'not_member'
  | 'role';

const REFUSALS: Record<SessionRefusal, string> = {
  invalid_button: 'This button is no longer valid. Answer in Nautelle.',
  not_linked: 'This chat is not linked to Nautelle.',
  unknown_message:
    'This message is not one Nautelle can act on any more. Answer in Nautelle.',
  inactive_user: 'Your Nautelle account is not active.',
  not_member: 'You are not a member of this project any more.',
  role: 'Messaging a session needs the operator role on the project.',
};

export const sessionRefusalText = (reason: SessionRefusal): string =>
  REFUSALS[reason];

const OUTCOMES: Record<SessionMessageOutcome, string> = {
  sent: 'Sent. The worker reads it at its next step.',
  answered: 'Answered.',
  no_session: 'The session is gone; nothing was sent.',
  question:
    'The session shows a question; press an option or reply with your answer.',
  question_changed:
    'The question has changed or is gone; nothing was sent. Answer in Nautelle.',
  not_at_input:
    'The session shows a dialog or a permission prompt; nothing was sent.',
  no_option: 'That option is not offered any more; nothing was sent.',
};

export const sessionOutcomeText = (outcome: SessionMessageOutcome): string =>
  OUTCOMES[outcome];

const ERRORS: Partial<Record<SessionMessageErrorCode, string>> = {
  invalid_message: 'Nothing is left of that message once cleaned.',
  not_running: 'The card has no running round any more; nothing was sent.',
  command_unavailable:
    'The runner is offline or cannot take messages; nothing was sent.',
  runner_timeout: 'The runner did not answer in time; it may have arrived.',
};

export const sessionErrorText = (code: string | null): string =>
  (code && ERRORS[code as SessionMessageErrorCode]) ??
  'The message could not be sent. Try in Nautelle.';

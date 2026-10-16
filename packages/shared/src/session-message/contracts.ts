import { z } from 'zod';

/**
 * #489: a person's message to a running agent session, and their answer to
 * the question selector it shows. Text only, never keystrokes (M1): what a
 * person writes is cleaned by `cleanSessionMessage` before it is audited,
 * sent or typed, and the runner refuses text that is not already clean.
 */

/** At most this many characters reach a session in one message (M1). */
export const SESSION_MESSAGE_MAX_CHARS = 4000;

/** At most this many options of a question selector are reported. */
export const PENDING_QUESTION_MAX_OPTIONS = 12;
export const PENDING_QUESTION_TEXT_MAX_CHARS = 2000;
export const PENDING_QUESTION_LABEL_MAX_CHARS = 300;

/** CSI (`ESC [ … final`), OSC (`ESC ] … BEL|ESC \`), DCS/SOS/PM/APC strings, then any other `ESC x`. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: escape sequences are what this strips
const ESCAPE_SEQUENCE = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b[PX^_][^\u001b]*(?:\u001b\\)?|\u009b[0-?]*[ -/]*[@-~]|\u001b[\s\S]?/g;
/** C0 and C1 controls and DEL; line breaks and tabs are handled before. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this strips
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
/** Zero-width and bidirectional formatting characters. */
const FORMAT = /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;

/**
 * M1: the text a session may receive. Escape sequences and control
 * characters are removed — a line break or a tab becomes a space, since
 * Enter would submit half a message — runs of spaces collapse, the ends are
 * trimmed, and the result is cut to `SESSION_MESSAGE_MAX_CHARS`.
 */
export const cleanSessionMessage = (text: string): string =>
  Array.from(
    text
      .normalize('NFC')
      .replace(ESCAPE_SEQUENCE, '')
      .replace(/[\r\n\t\v\f\u0085\u2028\u2029]+/g, ' ')
      .replace(CONTROL, '')
      .replace(FORMAT, '')
      .replace(/ {2,}/g, ' ')
      .trim(),
  )
    .slice(0, SESSION_MESSAGE_MAX_CHARS)
    .join('')
    .trim();

/** Text that `cleanSessionMessage` leaves as it is, and not empty. */
export const sessionMessageTextSchema = z
  .string()
  .min(1)
  .max(SESSION_MESSAGE_MAX_CHARS * 2)
  .refine((text) => cleanSessionMessage(text) === text, {
    message: 'must be clean session text (cleanSessionMessage)',
  });

/** One option of a question selector, as the pane numbers it. */
export const pendingQuestionOptionSchema = z.object({
  /** The option's number on screen, 1-based. */
  index: z.number().int().min(1).max(99),
  label: z.string().min(1).max(PENDING_QUESTION_LABEL_MAX_CHARS),
  description: z.string().max(PENDING_QUESTION_LABEL_MAX_CHARS).optional(),
});
export type PendingQuestionOption = z.infer<typeof pendingQuestionOptionSchema>;

/**
 * M4: the question selector a session shows (#473), read from its pane. It
 * is session content (ADR-0021): the runner reports it only for a project
 * that ships content.
 */
export const pendingQuestionSchema = z.object({
  /**
   * Names this screen of the selector — a hash of what it shows. An answer
   * carries it, and the runner sends nothing when the pane moved on.
   */
  key: z.string().regex(/^[0-9a-f]{16}$/),
  /** The selector's header (`glass-ui`, or the tabs of several questions). */
  header: z.string().max(PENDING_QUESTION_LABEL_MAX_CHARS).nullable(),
  text: z.string().max(PENDING_QUESTION_TEXT_MAX_CHARS),
  options: z
    .array(pendingQuestionOptionSchema)
    .min(1)
    .max(PENDING_QUESTION_MAX_OPTIONS),
  /** The selector offers a typed answer ("Type something."). */
  other: z.boolean(),
});
export type PendingQuestion = z.infer<typeof pendingQuestionSchema>;

/**
 * What a person sends: text, the option with that number, or a typed
 * answer in the selector's "Other" field. An answer names the screen it
 * answers (`PendingQuestion.key`).
 */
export const sessionMessageInputSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('text'), text: sessionMessageTextSchema }),
  z.strictObject({
    kind: z.literal('option'),
    questionKey: pendingQuestionSchema.shape.key,
    index: pendingQuestionOptionSchema.shape.index,
  }),
  z.strictObject({
    kind: z.literal('other'),
    questionKey: pendingQuestionSchema.shape.key,
    text: sessionMessageTextSchema,
  }),
]);
export type SessionMessageInput = z.infer<typeof sessionMessageInputSchema>;

/**
 * What became of a message. `sent`: typed and submitted — a busy session
 * queues it for its next step (M3). `answered`: the option was selected.
 * The rest sent nothing: `no_session` (the session is gone), `question`
 * (text while a selector is up — answer it instead), `question_changed`
 * (the selector is gone or shows another screen), `not_at_input` (a
 * dialog or permission prompt is up), `no_option` (no such option, or no
 * "Other" field).
 */
export const SESSION_MESSAGE_OUTCOMES = [
  'sent',
  'answered',
  'no_session',
  'question',
  'question_changed',
  'not_at_input',
  'no_option',
] as const;
export const sessionMessageOutcomeSchema = z.enum(SESSION_MESSAGE_OUTCOMES);
export type SessionMessageOutcome = z.infer<typeof sessionMessageOutcomeSchema>;

export const isDeliveredOutcome = (outcome: SessionMessageOutcome): boolean =>
  outcome === 'sent' || outcome === 'answered';

/** `POST /cards/:id/message` and `POST /projects/:id/slots/:slot/session-message`. */
export type SessionMessageRequest = SessionMessageInput;

export interface SessionMessageView {
  outcome: SessionMessageOutcome;
}

/** Where a message came from, as its audit row records it. */
export type SessionMessageVia = 'web' | 'telegram';

/** Stable codes in the `error` field of a message route's error body. */
export const SESSION_MESSAGE_ERROR = {
  /** Nothing is left once the text is cleaned, or the input is malformed. */
  invalidMessage: 'invalid_message',
  /** The card has no running round, or the slot is unknown here. */
  notRunning: 'not_running',
  /** The runner is offline, or does not serve `session.message`; nothing was sent. */
  commandUnavailable: 'command_unavailable',
  /** The runner refused the command. */
  runnerError: 'runner_error',
  /** No result came back in time; the message may or may not have arrived. */
  runnerTimeout: 'runner_timeout',
} as const;
export type SessionMessageErrorCode =
  (typeof SESSION_MESSAGE_ERROR)[keyof typeof SESSION_MESSAGE_ERROR];

/**
 * The input as the API takes it: text is cleaned (`cleanSessionMessage`)
 * first, and an input with nothing left is null.
 */
export const cleanSessionMessageInput = (
  input: SessionMessageInput,
): SessionMessageInput | null => {
  if (input.kind === 'option') return input;
  const text = cleanSessionMessage(input.text);
  return text.length > 0 ? { ...input, text } : null;
};

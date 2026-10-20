import { APPROVALS_ERROR } from '@nautelle/shared';
import { fitsInt8 } from './callback-data';
import type { InlineKeyboardButton } from './telegram-client';

export { CALLBACK_DATA_MAX } from './callback-data';

/**
 * #82 (spec 22 D12): what the Approve / Request changes buttons carry, and the
 * fixed text the bot answers with. Pure — `TelegramApprovalService` does the
 * checks and the calls.
 */

export type ApprovalAction = 'approve' | 'request_changes';

/** What a button press or a note reply acts on. */
export interface ApprovalTarget {
  /** The `pr.awaiting_approval` notification the message was sent for. */
  notificationId: bigint;
  pr: number;
  /** The head the message showed; the decision is bound to it (spec 20 D6). */
  headSha: string;
}

export interface ApprovalPress extends ApprovalTarget {
  action: ApprovalAction;
}

const SHA = /^[0-9a-f]{40}$/;
const ACTION_CODE: Record<ApprovalAction, string> = {
  approve: 'a',
  request_changes: 'r',
};
/** `a:<notification id>:<pr>:<sha as 27 base64url characters>`. */
const CALLBACK = /^([ar]):(\d{1,19}):(\d{1,9}):([A-Za-z0-9_-]{27})$/;
/** The last line of the request-changes prompt: `Ref <notification>/<pr>/<sha>`. */
const REFERENCE = /^Ref (\d{1,19})\/(\d{1,9})\/([0-9a-f]{40})$/m;

/** A full Git object id: the only head a button may carry. */
export const isHeadSha = (value: unknown): value is string =>
  typeof value === 'string' && SHA.test(value);

const positive = (text: string): number | null => {
  const value = Number(text);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
};

export const shortSha = (sha: string): string => sha.slice(0, 7);

export const encodeCallback = (press: ApprovalPress): string => {
  if (!isHeadSha(press.headSha)) throw new Error('not a 40-hex head SHA');
  const sha = Buffer.from(press.headSha, 'hex').toString('base64url');
  return `${ACTION_CODE[press.action]}:${press.notificationId}:${press.pr}:${sha}`;
};

/** Null for anything this bot did not put on a button. */
export const decodeCallback = (
  data: string | undefined,
): ApprovalPress | null => {
  const match = data ? CALLBACK.exec(data) : null;
  if (!match) return null;
  const pr = positive(match[3]);
  const headSha = Buffer.from(match[4], 'base64url').toString('hex');
  if (pr === null || !isHeadSha(headSha) || !fitsInt8(match[2])) return null;
  return {
    action: match[1] === 'a' ? 'approve' : 'request_changes',
    notificationId: BigInt(match[2]),
    pr,
    headSha,
  };
};

/** The two buttons of a `pr.awaiting_approval` message. */
export const approvalKeyboard = (
  target: ApprovalTarget,
): InlineKeyboardButton[][] => [
  [
    {
      text: 'Approve',
      callback_data: encodeCallback({ ...target, action: 'approve' }),
    },
    {
      text: 'Request changes',
      callback_data: encodeCallback({ ...target, action: 'request_changes' }),
    },
  ],
];

/**
 * The force-reply prompt for a note. Its last line carries the target back:
 * Telegram hands the replied-to message with the reply, so no state is kept.
 */
export const notePrompt = (target: ApprovalTarget): string =>
  [
    `Reply to this message with the note for the worker on PR #${target.pr}.`,
    `Head ${shortSha(target.headSha)}.`,
    `Ref ${target.notificationId}/${target.pr}/${target.headSha}`,
  ].join('\n');

/** The target of a note prompt's text; null for any other text. */
export const parseNotePrompt = (
  text: string | undefined,
): ApprovalTarget | null => {
  const match = text ? REFERENCE.exec(text) : null;
  if (!match) return null;
  const pr = positive(match[2]);
  if (pr === null || !fitsInt8(match[1])) return null;
  return { notificationId: BigInt(match[1]), pr, headSha: match[3] };
};

/** Why a press or a note was refused before #20's service was called. */
export type ApprovalRefusal =
  | 'invalid_button'
  | 'not_linked'
  | 'unknown_message'
  | 'inactive_user'
  | 'not_member'
  | 'role';

const REFUSALS: Record<ApprovalRefusal, string> = {
  invalid_button: 'This button is no longer valid. Decide in Nautelle.',
  not_linked: 'This chat is not linked to Nautelle.',
  unknown_message:
    'This message is not one Nautelle can act on any more. Decide in Nautelle.',
  inactive_user: 'Your Nautelle account is not active.',
  not_member: 'You are not a member of this project any more.',
  role: 'Only an operator or an admin of this project can approve or request changes.',
};

export const refusalText = (reason: ApprovalRefusal): string =>
  REFUSALS[reason];

/** #20's refusal, in the bot's words. The service's own message is not echoed. */
export const serviceErrorText = (code: string | null, pr: number): string => {
  switch (code) {
    case APPROVALS_ERROR.headMoved:
      return `PR #${pr} has new commits since this message. Review the new head in Nautelle.`;
    case APPROVALS_ERROR.notWaiting:
      return `PR #${pr} is not waiting for a decision.`;
    case APPROVALS_ERROR.approvalNotFound:
      return `PR #${pr} is not in this project's approval queue.`;
    case APPROVALS_ERROR.prNotOpen:
      return `PR #${pr} is no longer open.`;
    case APPROVALS_ERROR.noteRequired:
      return 'Requesting changes needs a note. Press Request changes again and reply with text.';
    case APPROVALS_ERROR.noteTooLong:
      return 'The note is too long: at most 4 KB.';
    case APPROVALS_ERROR.commandUnavailable:
      return 'The runner could not be reached. Try again in a moment.';
    default:
      return 'The decision could not be recorded. Try again, or decide in Nautelle.';
  }
};

export const successText = (action: ApprovalAction, target: ApprovalTarget) =>
  action === 'approve'
    ? `Approved PR #${target.pr} at ${shortSha(target.headSha)}.`
    : `Changes requested on PR #${target.pr}. The note goes to the worker.`;

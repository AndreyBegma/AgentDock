import { fitsInt8 } from './callback-data';
import type { InlineKeyboardButton } from './telegram-client';

/**
 * Spec 201 D18: the Approve / Deny buttons of an `action.requested`
 * message, and the bot's fixed answers. Pure — `TelegramActionRequestService`
 * does the checks and the calls.
 */

export type ActionRequestPressAction = 'approve' | 'deny';

export interface ActionRequestPress {
  action: ActionRequestPressAction;
  /** The `action.requested` notification the message was sent for. */
  notificationId: bigint;
  actionRequestId: string;
}

const ACTION_CODE: Record<ActionRequestPressAction, string> = {
  approve: 'x',
  deny: 'y',
};
/** `x:<notification id>:<action request id>`; `y` denies. ≤ 64 bytes. */
const CALLBACK = /^([xy]):(\d{1,19}):([A-Za-z0-9_-]{1,40})$/;

export const encodeActionRequestCallback = (press: ActionRequestPress) =>
  `${ACTION_CODE[press.action]}:${press.notificationId}:${press.actionRequestId}`;

/** Null for anything that is not an action-request button. */
export const decodeActionRequestCallback = (
  data: string | undefined,
): ActionRequestPress | null => {
  const match = data ? CALLBACK.exec(data) : null;
  if (!match || !fitsInt8(match[2])) return null;
  return {
    action: match[1] === 'x' ? 'approve' : 'deny',
    notificationId: BigInt(match[2]),
    actionRequestId: match[3],
  };
};

/** Whether a callback belongs to the action-request buttons (`x:`/`y:`). */
export const isActionRequestCallback = (data: string | undefined): boolean =>
  typeof data === 'string' && /^[xy]:/.test(data);

export const actionRequestKeyboard = (target: {
  notificationId: bigint;
  actionRequestId: string;
}): InlineKeyboardButton[][] => [
  [
    {
      text: 'Approve',
      callback_data: encodeActionRequestCallback({
        ...target,
        action: 'approve',
      }),
    },
    {
      text: 'Deny',
      callback_data: encodeActionRequestCallback({ ...target, action: 'deny' }),
    },
  ],
];

/** Why a press was refused before the action-request service was called. */
export type ActionRequestRefusal =
  | 'invalid_button'
  | 'not_linked'
  | 'unknown_message'
  | 'inactive_user'
  | 'not_member'
  | 'role';

const REFUSALS: Record<ActionRequestRefusal, string> = {
  invalid_button: 'This button is no longer valid. Decide in Nautelle.',
  not_linked: 'This chat is not linked to Nautelle.',
  unknown_message:
    'This message is not one Nautelle can act on any more. Decide in Nautelle.',
  inactive_user: 'Your Nautelle account is not active.',
  not_member: 'You are not a member of this project any more.',
  role: 'Only an operator or an admin of this project can decide this request.',
};

export const actionRequestRefusalText = (reason: ActionRequestRefusal) =>
  REFUSALS[reason];

/** The service's refusal, in the bot's words. */
export const actionRequestErrorText = (code: string | null): string => {
  switch (code) {
    case 'not_pending':
      return 'This request was already decided, or it expired.';
    case 'self_approval':
      return 'You cannot approve your own request. Another operator or an admin has to.';
    case 'not_found':
      return 'This request is not in Nautelle any more.';
    default:
      return 'The decision could not be recorded. Try again, or decide in Nautelle.';
  }
};

/** The answer once decided; an approval that failed to execute says so. */
export const actionRequestDecidedText = (
  action: ActionRequestPressAction,
  status: string,
  failure: string | null,
): string => {
  if (action === 'deny') return 'Denied.';
  if (status === 'failed' && failure === 'head_moved') {
    return 'Not approved: the pull request has new commits since this request. Ask for a new one.';
  }
  if (status === 'failed') {
    return `Approved, but it could not be carried out${failure ? `: ${failure}` : ''}.`;
  }
  return status === 'executed' ? 'Approved and carried out.' : 'Approved.';
};

import {
  BOARD_ERROR,
  type BoardCardDetail,
  type CardCollectOutcome,
  type CardPullRequestView,
  type CardReviewAction,
  cardLabel,
} from '@agentdock/shared';
import { callbackCodec } from './callback-data';
import type { InlineKeyboardButton } from './telegram-client';
import type { GuardRefusal } from './telegram-guard.service';

/**
 * #578: the review-side card actions on Telegram — the buttons a card
 * message carries, the confirm step of Accept and Finish, the force-reply
 * prompts of Feedback and Message session, and the bot's fixed answers.
 * Pure: `TelegramCardService` does the checks and the calls. Every text is
 * about cards, columns and pull requests; a suggestion's title, which is
 * content-derived, is never quoted (spec 22 D10).
 */

/** `ca:<card>:<action>`: a card action button. */
export const CARD_ACTION_CALLBACK = callbackCodec('ca', {
  card: 'card',
  action: 'word',
});

/** `cc:<card>:<step>`: a confirm step — accept (without merging), finish, cancel. */
export const CARD_CONFIRM_CALLBACK = callbackCodec('cc', {
  card: 'card',
  step: 'word',
});

/** `cm:<card>:<head>`: Accept and merge, bound to the head the prompt showed. */
export const CARD_MERGE_CALLBACK = callbackCodec('cm', {
  card: 'card',
  head: 'sha',
});

export type ConfirmStep = 'accept' | 'finish' | 'cancel';
const CONFIRM_STEPS: readonly string[] = ['accept', 'finish', 'cancel'];
export const isConfirmStep = (word: string): word is ConfirmStep =>
  CONFIRM_STEPS.includes(word);

/** The word an action goes as on a button: a `word` field holds 16 characters. */
const WIRE: Record<CardReviewAction, string> = {
  message: 'message',
  finish: 'finish',
  accept: 'accept',
  feedback: 'feedback',
  collect: 'collect',
  accept_suggestion: 'accept_inbox',
  dismiss: 'dismiss',
};
export const actionWord = (action: CardReviewAction): string => WIRE[action];

/** The action a button's word names; null for any other word. */
export const actionOfWord = (word: string): CardReviewAction | null =>
  (Object.keys(WIRE) as CardReviewAction[]).find((a) => WIRE[a] === word) ??
  null;

/** The head a merge button carries: its first 12 hex digits. */
export const headPrefix = (sha: string): string => sha.slice(0, 12);

const LABEL: Record<CardReviewAction, string> = {
  message: 'Message session',
  finish: 'Finish',
  accept: 'Accept',
  feedback: 'Give feedback',
  collect: 'Create pull request',
  accept_suggestion: 'Accept suggestion',
  dismiss: 'Dismiss',
};

/** The buttons of `actions`, two to a row. */
export const reviewKeyboard = (
  shortId: string,
  actions: readonly CardReviewAction[],
): InlineKeyboardButton[][] => {
  const buttons = actions.map((action) => ({
    text: LABEL[action],
    callback_data: CARD_ACTION_CALLBACK.encode({
      card: shortId,
      action: WIRE[action],
    }),
  }));
  const rows: InlineKeyboardButton[][] = [];
  for (let i = 0; i < buttons.length; i += 2)
    rows.push(buttons.slice(i, i + 2));
  return rows;
};

/** `cards.suggested`: one row per suggestion, Accept and Dismiss. */
export const suggestionRows = (
  cards: readonly { shortId: string; number: number }[],
): InlineKeyboardButton[][] =>
  cards.map((card) => [
    {
      text: `Accept ${cardLabel(card.number)}`,
      callback_data: CARD_ACTION_CALLBACK.encode({
        card: card.shortId,
        action: WIRE.accept_suggestion,
      }),
    },
    {
      text: `Dismiss ${cardLabel(card.number)}`,
      callback_data: CARD_ACTION_CALLBACK.encode({
        card: card.shortId,
        action: 'dismiss',
      }),
    },
  ]);

/** The last line of a force-reply prompt: `Ref feedback|message <shortId>`. */
const REFERENCE = /^Ref (feedback|message) ([a-z0-9]{8})$/m;

export type ReplyAction = 'feedback' | 'message';

export const feedbackPrompt = (label: string, shortId: string): string =>
  [
    `Reply to this message with your feedback for ${label}.`,
    'Its worker resumes with it, and the card goes back to In progress.',
    `Ref feedback ${shortId}`,
  ].join('\n');

export const messagePrompt = (
  label: string,
  slot: string | null,
  shortId: string,
): string =>
  [
    slot
      ? `Reply to this message, and your reply goes to ${slot}, the worker of ${label}. Its orchestrator is told.`
      : `Reply to this message, and your reply goes to ${label}'s running session.`,
    `Ref message ${shortId}`,
  ].join('\n');

/** The action and card a prompt's text names; null for any other text. */
export const parseCardPrompt = (
  text: string | undefined,
): { action: ReplyAction; card: string } | null => {
  const match = text ? REFERENCE.exec(text) : null;
  if (!match) return null;
  return { action: match[1] as ReplyAction, card: match[2] };
};

/** The confirm step of Accept: what it does, and its buttons. */
export const acceptConfirm = (
  card: Pick<BoardCardDetail, 'label' | 'source' | 'prNumber'> & {
    shortId: string;
    baseBranch: string | null;
  },
  pr: CardPullRequestView | null,
): { text: string; keyboard: InlineKeyboardButton[][] } => {
  const shortId = card.shortId;
  const cancel = {
    text: 'Cancel',
    callback_data: CARD_CONFIRM_CALLBACK.encode({
      card: shortId,
      step: 'cancel',
    }),
  };
  const acceptOnly = (label: string) => ({
    text: label,
    callback_data: CARD_CONFIRM_CALLBACK.encode({
      card: shortId,
      step: 'accept',
    }),
  });
  const merge = (label: string, headSha: string) => ({
    text: label,
    callback_data: CARD_MERGE_CALLBACK.encode({
      card: shortId,
      head: headPrefix(headSha),
    }),
  });
  const title = `Accept ${card.label}?`;
  const moves = 'and moves the card to Completed.';
  if (card.source !== 'fleet' && pr?.state === 'open' && pr.canMerge) {
    return {
      text: [
        title,
        `This merges PR #${pr.number}${card.baseBranch ? ` into ${card.baseBranch}` : ''} ${moves}`,
      ].join('\n'),
      keyboard: [
        [cancel, merge('Accept and merge', pr.headSha)],
        [acceptOnly('Accept without merging')],
      ],
    };
  }
  if (card.source !== 'fleet' && pr?.state === 'merged') {
    return {
      text: [
        title,
        `PR #${pr.number} is merged. This closes its issue ${moves}`,
      ].join('\n'),
      keyboard: [[cancel, merge('Accept', pr.headSha)]],
    };
  }
  const why =
    card.source === 'fleet'
      ? 'The orchestrator merges a fleet pull request, so nothing is merged.'
      : card.prNumber === null
        ? 'The card has no pull request.'
        : pr === null
          ? 'The pull request could not be read, so it is not merged.'
          : pr.state === 'closed'
            ? `PR #${pr.number} is closed, so nothing is merged.`
            : 'The runner cannot merge now, so nothing is merged.';
  return {
    text: [title, why, `Accepting closes its worker ${moves}`].join('\n'),
    keyboard: [[cancel, acceptOnly('Accept')]],
  };
};

export const finishConfirm = (card: {
  label: string;
  shortId: string;
}): { text: string; keyboard: InlineKeyboardButton[][] } => ({
  text: [
    `Mark ${card.label} finished?`,
    'Its round ends as it is, and the card moves to Finished for review.',
  ].join('\n'),
  keyboard: [
    [
      {
        text: 'Cancel',
        callback_data: CARD_CONFIRM_CALLBACK.encode({
          card: card.shortId,
          step: 'cancel',
        }),
      },
      {
        text: 'Finish',
        callback_data: CARD_CONFIRM_CALLBACK.encode({
          card: card.shortId,
          step: 'finish',
        }),
      },
    ],
  ],
});

export const CANCELLED_TEXT = 'Cancelled. Nothing changed.';

/** Why a press or a reply was refused before a Board service was called. */
export type CardRefusal =
  | 'invalid_button'
  | 'unknown_card'
  | 'not_allowed'
  | 'invalid_text'
  | GuardRefusal;

const REFUSALS: Record<CardRefusal, string> = {
  invalid_button:
    'This button is no longer valid. Act on the card in Nautelle.',
  not_linked: 'This chat is not linked to Nautelle.',
  unknown_card: 'That card does not exist any more.',
  inactive_user: 'Your Nautelle account is not active.',
  not_member: 'You are not a member of this project any more.',
  role: 'Your role on this project does not allow that, so nothing changed.',
  not_allowed:
    "The card's state does not allow that now, so nothing changed. Send /card with its number to see what it offers.",
  invalid_text: 'Reply with text: nothing was sent.',
};

export const cardRefusalText = (reason: CardRefusal): string =>
  REFUSALS[reason];

const ERRORS: Partial<Record<string, string>> = {
  [BOARD_ERROR.wrongColumn]:
    "The card's state does not allow that now, so nothing changed.",
  [BOARD_ERROR.cardRunning]:
    'A worker is running on this card, so nothing changed.',
  [BOARD_ERROR.notRunning]:
    'No worker is running on this card any more, so nothing changed.',
  [BOARD_ERROR.noPullRequest]: 'The card has no pull request.',
  [BOARD_ERROR.commandUnavailable]:
    'The runner is offline or cannot do that now. Try again in a moment.',
  [BOARD_ERROR.maxRunning]:
    'The project runs as many workers as it allows. Try again when one finishes.',
  [BOARD_ERROR.budgetExceeded]:
    'A budget stops new rounds, so nothing changed.',
  [BOARD_ERROR.noProfile]:
    'No runtime profile can run this card. Fix it in Nautelle.',
};

const MERGE_REFUSED: Record<string, string> = {
  head_changed:
    'The pull request has new commits since this message. Tap Accept again to see them.',
  not_mergeable: 'GitHub cannot merge the pull request as it is.',
  closed: 'The pull request is closed.',
};

/** A Board service's refusal, in the bot's words; its own message is not echoed. */
export const boardErrorText = (
  code: string | null,
  reason: string | null,
): string => {
  if (code === BOARD_ERROR.mergeFailed) {
    return `The merge was refused, so the card stays in Finished. ${
      (reason && MERGE_REFUSED[reason]) ?? 'Merge it in Nautelle.'
    }`;
  }
  return (
    (code && ERRORS[code]) ??
    'That did not work, and nothing changed. Try again, or act in Nautelle.'
  );
};

export const HEAD_MOVED_TEXT =
  'The pull request has new commits since this message. Tap Accept again to see them.';

/** The service line of an action that worked. */
export const resultLine = (
  action: CardReviewAction,
  label: string,
  extra: { merged?: number | null; collect?: CardCollectOutcome } = {},
): string => {
  switch (action) {
    case 'accept':
      return extra.merged
        ? `${label} accepted · Completed. PR #${extra.merged} is merged.`
        : `${label} accepted · Completed.`;
    case 'finish':
      return `${label} marked finished · Finished.`;
    case 'feedback':
      return `Feedback sent. ${label} is back in progress.`;
    case 'accept_suggestion':
      return `${label} accepted into To Do.`;
    case 'dismiss':
      return `${label} dismissed. Capture will not suggest it again.`;
    case 'collect': {
      const outcome = extra.collect;
      if (outcome?.state === 'ok') {
        return `Pull request opened for ${label}${outcome.prNumber ? `: PR #${outcome.prNumber}` : ''}.`;
      }
      if (outcome?.state === 'no_changes') {
        return `${label} has nothing to push, so no pull request was opened.`;
      }
      return `No pull request for ${label}: collecting the work failed. See the card in Nautelle.`;
    }
    case 'message':
      return `Message sent to ${label}.`;
  }
};

import {
  type CardCiState,
  type CardReviewAction,
  cardLabel,
  TELEGRAM_BOT_UPLOAD_MAX_BYTES,
} from '@nautelle/shared';
import { actionWord, CARD_ACTION_CALLBACK } from './card-actions';
import type {
  InlineButton,
  InlineKeyboardButton,
  WebAppButton,
} from './telegram-client';

/**
 * C-372 (ADR-0095): the Telegram message of a card's demo video — the video
 * with its caption, the text that stands in for a video over Telegram's
 * upload limit, the one line of a failed demo, and the Merge / Feedback /
 * Open card buttons. Pure: `TelegramDemoService` reads the card and sends.
 * Every text is plain, never `MarkdownV2`.
 */

/** Characters of a card title or a reason in a demo message. */
const LINE_MAX = 200;

const clip = (value: string): string => {
  const line = value.replace(/\s+/g, ' ').trim();
  return line.length > LINE_MAX ? `${line.slice(0, LINE_MAX - 1)}…` : line;
};

const CI_TEXT: Record<CardCiState, string> = {
  none: 'no CI checks',
  pending: 'CI running',
  green: 'CI green',
  red: 'CI red',
};

export interface DemoFacts {
  number: number;
  title: string;
  projectName: string | null;
  prNumber: number | null;
  ciState: CardCiState;
  /** The card in the web app, when no Open card button can carry it. */
  link: string | null;
}

/** Whether a video of `size` bytes can go to the chat as a video. */
export const demoFitsUpload = (size: number): boolean =>
  size <= TELEGRAM_BOT_UPLOAD_MAX_BYTES;

/** `61.2 MB`: Telegram's own unit, 1 MB = 1024 × 1024 bytes. */
export const megabytes = (size: number): string =>
  `${(size / (1024 * 1024)).toFixed(1)} MB`;

const factLines = (facts: DemoFacts): string[] => [
  `${cardLabel(facts.number)} demo: ${clip(facts.title)}`,
  facts.prNumber === null
    ? `No pull request yet · ${CI_TEXT[facts.ciState]}`
    : `PR #${facts.prNumber} · ${CI_TEXT[facts.ciState]}`,
  ...(facts.projectName ? [facts.projectName] : []),
];

/** The caption of a demo sent as a video. */
export const demoCaption = (facts: DemoFacts): string =>
  [...factLines(facts), ...(facts.link ? [facts.link] : [])].join('\n');

/** The message of a demo over the upload limit: the facts, the size, the card. */
export const demoOverLimitText = (facts: DemoFacts, size: number): string =>
  [
    ...factLines(facts),
    `The video is ${megabytes(size)}, over Telegram's ${megabytes(TELEGRAM_BOT_UPLOAD_MAX_BYTES)} limit for a bot: watch it on the card.`,
    ...(facts.link ? [facts.link] : []),
  ].join('\n');

/** A failed demo: one line with the reason, no video. */
export const demoFailedLine = (number: number, reason: string | null): string =>
  `${cardLabel(number)} demo failed: ${reason?.trim() ? clip(reason) : 'the recording did not finish.'}`;

/**
 * Merge (the card's Accept, which asks before it merges), Feedback, and Open
 * card. Merge and Feedback only when the card allows them now; Merge only with
 * a pull request.
 */
export const demoKeyboard = (
  shortId: string,
  actions: readonly CardReviewAction[],
  hasPullRequest: boolean,
  open: WebAppButton | null,
): InlineButton[][] => {
  const press = (action: CardReviewAction, text: string) => ({
    text,
    callback_data: CARD_ACTION_CALLBACK.encode({
      card: shortId,
      action: actionWord(action),
    }),
  });
  const row: InlineKeyboardButton[] = [
    ...(hasPullRequest && actions.includes('accept')
      ? [press('accept', 'Merge')]
      : []),
    ...(actions.includes('feedback') ? [press('feedback', 'Feedback')] : []),
  ];
  return [...(row.length > 0 ? [row] : []), ...(open ? [[open]] : [])];
};

import {
  BOARD_ACTION_ERROR_TEXT,
  BOARD_COLUMNS,
  BOARD_ERROR,
  type BoardCardDetail,
  type BoardCardView,
  type BoardColumn,
  type BoardErrorCode,
  type BoardMoveRefusal,
  COLUMN_TITLE,
  canRetry,
  canRun,
  canStop,
  MOVE_REFUSAL_TEXT,
  ROUND_PHASE_LABEL,
} from '@agentdock/shared';
import { callbackCodec } from './callback-data';
import { appLink } from './markdown-v2';
import { OPEN_IN_APP_TEXT, openInAppButton } from './mini-app-buttons';
import type {
  InlineButton,
  InlineKeyboard,
  InlineKeyboardButton,
} from './telegram-client';

/**
 * #576: the Board on Telegram — what its buttons carry and how a column, a
 * card and a refusal read in a chat. Pure: `TelegramBoardService` does the
 * checks and the calls. Every codec names its project, so a button never
 * depends on the chat's current project (ADR-0046 D5); a card is its
 * per-project number.
 */

/** Cards on one page of a column. */
export const BOARD_PAGE_SIZE = 10;

/** `bb:<project>`: the columns with their counts. */
export const BOARD_VIEW_CALLBACK = callbackCodec('bb', { project: 'project' });
/** `bl:<project>:<column>:<page>`: one page of a column. */
export const COLUMN_CALLBACK = callbackCodec('bl', {
  project: 'project',
  column: 'column',
  page: 'page',
});
/** `bc:<project>:<number>`: a card's detail. */
export const CARD_CALLBACK = callbackCodec('bc', {
  project: 'project',
  number: 'number',
});
/** `bm:<project>:<number>`: the column picker of Move. */
export const MOVE_PICK_CALLBACK = callbackCodec('bm', {
  project: 'project',
  number: 'number',
});
/** `bt:<project>:<number>:<column>`: move the card to the column. */
export const MOVE_CALLBACK = callbackCodec('bt', {
  project: 'project',
  number: 'number',
  column: 'column',
});
/** `br:<project>:<number>`: Run. */
export const RUN_CALLBACK = callbackCodec('br', {
  project: 'project',
  number: 'number',
});
/** `bs:<project>:<number>`: Stop, asking to confirm. */
export const STOP_ASK_CALLBACK = callbackCodec('bs', {
  project: 'project',
  number: 'number',
});
/** `bk:<project>:<number>`: Stop, confirmed. */
export const STOP_CALLBACK = callbackCodec('bk', {
  project: 'project',
  number: 'number',
});

export const BOARD_CALLBACK_PREFIXES = [
  BOARD_VIEW_CALLBACK,
  COLUMN_CALLBACK,
  CARD_CALLBACK,
  MOVE_PICK_CALLBACK,
  MOVE_CALLBACK,
  RUN_CALLBACK,
  STOP_ASK_CALLBACK,
  STOP_CALLBACK,
].map((codec) => codec.prefix);

const TEXT_MAX = 4000;
const TITLE_MAX = 60;
const BODY_MAX = 400;
const NOTICE_MAX = 180;

export const clip = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

export const BOARD_REPLIES = {
  invalidButton: 'This button is no longer valid. Send /board again.',
  noColumn:
    'There is no such column. Send /board for the columns of this project.',
  cardUsage: 'Send /card with a card number, for example /card 12.',
  privateOnly: 'The Board is in a private chat with the bot only.',
  roleDenied:
    'Your role on this project does not allow that, so nothing changed.',
} as const;

export const cardMissingText = (number: number): string =>
  `This project has no card C-${number}.`;

/** `/card 12`, `/card C-12`, `/card #12`: the number, else null. */
export const parseCardNumber = (arg: string): number | null => {
  const match = /^(?:c-?|#)?(\d{1,9})$/i.exec(arg.trim());
  const number = match ? Number(match[1]) : 0;
  return number > 0 ? number : null;
};

/** `/board todo`, `/board in progress`, `/board "To Do"`: the column, else null. */
export const parseColumn = (arg: string): BoardColumn | null => {
  const key = arg
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  return (
    BOARD_COLUMNS.find(
      (column) =>
        column === key ||
        COLUMN_TITLE[column].toLowerCase().replace(/\s+/g, '_') === key,
    ) ?? null
  );
};

/** The state a row shows: the worker's, else the column it sits in. */
export const cardState = (card: BoardCardView): string => {
  const phase = card.round?.phase;
  return phase && phase !== 'finished'
    ? ROUND_PHASE_LABEL[phase]
    : COLUMN_TITLE[card.column];
};

export interface ColumnCount {
  column: BoardColumn;
  count: number;
  /** Completed holds a page only; more are in the app. */
  more: boolean;
}

export const boardText = (counts: ColumnCount[]): string =>
  counts.length === 0
    ? 'The Board is empty.'
    : 'Pick a column to see its cards.';

export const boardKeyboard = (
  projectId: string,
  counts: ColumnCount[],
): InlineKeyboard =>
  counts.map((entry) => [
    {
      text: `${COLUMN_TITLE[entry.column]} · ${entry.count}${entry.more ? '+' : ''}`,
      callback_data: COLUMN_CALLBACK.encode({
        project: projectId,
        column: entry.column,
        page: 0,
      }),
    },
  ]);

export const pageCount = (total: number): number =>
  Math.max(1, Math.ceil(total / BOARD_PAGE_SIZE));

export const columnText = (
  column: BoardColumn,
  cards: BoardCardView[],
  page: number,
  more: boolean,
): string => {
  const pages = pageCount(cards.length);
  const rows = cards.slice(
    page * BOARD_PAGE_SIZE,
    (page + 1) * BOARD_PAGE_SIZE,
  );
  return [
    `${COLUMN_TITLE[column]} · ${cards.length}${more ? '+' : ''} cards · page ${page + 1} of ${pages}`,
    ...(rows.length === 0
      ? ['No cards here.']
      : rows.map(
          (card) =>
            `${card.label} ${clip(card.title, TITLE_MAX)} · ${cardState(card)}`,
        )),
    ...(more ? ['Older completed cards are in the app.'] : []),
  ].join('\n');
};

export const columnKeyboard = (
  projectId: string,
  column: BoardColumn,
  cards: BoardCardView[],
  page: number,
): InlineKeyboard => {
  const rows = cards.slice(
    page * BOARD_PAGE_SIZE,
    (page + 1) * BOARD_PAGE_SIZE,
  );
  const nav: InlineKeyboardButton[] = [];
  if (page > 0) {
    nav.push({
      text: '‹ Prev',
      callback_data: COLUMN_CALLBACK.encode({
        project: projectId,
        column,
        page: page - 1,
      }),
    });
  }
  if (page + 1 < pageCount(cards.length)) {
    nav.push({
      text: 'Next ›',
      callback_data: COLUMN_CALLBACK.encode({
        project: projectId,
        column,
        page: page + 1,
      }),
    });
  }
  return [
    ...rows.map((card) => [
      {
        text: clip(`${card.label} ${card.title}`, TITLE_MAX),
        callback_data: CARD_CALLBACK.encode({
          project: projectId,
          number: card.number,
        }),
      },
    ]),
    ...(nav.length > 0 ? [nav] : []),
    [
      {
        text: '‹ Board',
        callback_data: BOARD_VIEW_CALLBACK.encode({ project: projectId }),
      },
    ],
  ];
};

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** The card's detail: what it is, where it stands, a trimmed body. */
export const cardText = (card: BoardCardDetail, service?: string): string => {
  const phase = card.round?.phase;
  const pr =
    card.prNumber !== null
      ? [
          `Pull request: #${card.prNumber}${card.prState ? ` ${card.prState}` : ''}${
            card.ciState !== 'none' ? ` · checks ${card.ciState}` : ''
          }`,
        ]
      : [];
  const agent = phase
    ? `Agent: ${ROUND_PHASE_LABEL[phase]} (round ${card.round?.round})`
    : card.tracking
      ? `Session: tracked from a terminal${card.tracking.alive ? ', running' : ''}`
      : 'Agent: not started';
  const summary = oneLine(card.body);
  return clip(
    [
      ...(service ? [service] : []),
      `${card.label} ${card.title}`,
      `Kind: ${card.kind} · Column: ${COLUMN_TITLE[card.column]}`,
      agent,
      ...pr,
      ...(summary ? ['', clip(summary, BODY_MAX)] : []),
    ].join('\n'),
    TEXT_MAX,
  );
};

/**
 * A card's buttons: the actions its state allows by the web's rules, only for
 * a reader who may write; then its link and the way back.
 */
export const cardKeyboard = (
  projectId: string,
  card: BoardCardView,
  canWrite: boolean,
  appUrl: string | null,
): InlineKeyboard => {
  const target = { project: projectId, number: card.number };
  const actions: InlineButton[] = [];
  if (canWrite) {
    actions.push({
      text: 'Move',
      callback_data: MOVE_PICK_CALLBACK.encode(target),
    });
    if (canRun(card) || canRetry(card)) {
      actions.push({
        text: canRun(card) ? 'Run' : 'Retry',
        callback_data: RUN_CALLBACK.encode(target),
      });
    }
    if (canStop(card)) {
      actions.push({
        text: 'Stop',
        callback_data: STOP_ASK_CALLBACK.encode(target),
      });
    }
  }
  // #580: the Mini App with an https APP_URL; else the plain web link.
  const link = appLink(
    appUrl,
    `/projects/${projectId}/board/cards/${card.number}`,
  );
  const open =
    openInAppButton(appUrl, { projectId, card: card.number }) ??
    (link ? { text: OPEN_IN_APP_TEXT, url: link } : null);
  return [
    ...(actions.length > 0 ? [actions] : []),
    [
      ...(open ? [open] : []),
      {
        text: `‹ ${COLUMN_TITLE[card.column]}`,
        callback_data: COLUMN_CALLBACK.encode({
          project: projectId,
          column: card.column,
          page: 0,
        }),
      },
    ],
  ];
};

export const movePickText = (card: BoardCardView): string =>
  `Move ${card.label} ${clip(card.title, TITLE_MAX)} to which column? It is in ${COLUMN_TITLE[card.column]}.`;

export const movePickKeyboard = (
  projectId: string,
  card: BoardCardView,
): InlineKeyboard => [
  ...BOARD_COLUMNS.filter(
    (column) => column !== card.column && column !== 'inbox',
  ).map((column) => [
    {
      text: COLUMN_TITLE[column],
      callback_data: MOVE_CALLBACK.encode({
        project: projectId,
        number: card.number,
        column,
      }),
    },
  ]),
  [
    {
      text: 'Cancel',
      callback_data: CARD_CALLBACK.encode({
        project: projectId,
        number: card.number,
      }),
    },
  ],
];

export const stopAskText = (card: BoardCardView): string =>
  `Stop the worker on ${card.label} ${clip(card.title, TITLE_MAX)}? The session ends; its work so far stays on the card's branch.`;

export const stopAskKeyboard = (
  projectId: string,
  card: BoardCardView,
): InlineKeyboard => {
  const target = { project: projectId, number: card.number };
  return [
    [
      { text: 'Stop worker', callback_data: STOP_CALLBACK.encode(target) },
      { text: 'Cancel', callback_data: CARD_CALLBACK.encode(target) },
    ],
  ];
};

/** What the board answered a refused action with, in the web's words. */
export const boardFailureText = (
  code: string | null,
  reason: string | undefined,
  message: string,
): string => {
  if (code === BOARD_ERROR.moveRefused) {
    return reason && reason in MOVE_REFUSAL_TEXT
      ? MOVE_REFUSAL_TEXT[reason as BoardMoveRefusal]
      : 'That move is not allowed.';
  }
  if (code === BOARD_ERROR.notFound) return 'That card no longer exists.';
  if (code === BOARD_ERROR.commandUnavailable) {
    return 'The runner is offline or too old to run card workers.';
  }
  const shared = code ? BOARD_ACTION_ERROR_TEXT[code as BoardErrorCode] : null;
  return shared ?? clip(message, NOTICE_MAX);
};

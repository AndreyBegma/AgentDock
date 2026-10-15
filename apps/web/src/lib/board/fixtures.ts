import {
  BOARD_COLUMNS,
  type BoardCardView,
  type BoardColumn,
  type BoardView,
  type CardRoundBrief,
  type CardRoundPhase,
} from '@agentdock/shared';

/** Test builders for the Board's wire shapes. */

export const round = (
  phase: CardRoundPhase,
  extra: Partial<CardRoundBrief> = {},
): CardRoundBrief => ({
  round: 1,
  phase,
  finishedBy: null,
  waitingAt: null,
  hooksMissing: false,
  ...extra,
});

export const card = (
  number: number,
  column: BoardColumn,
  extra: Partial<BoardCardView> = {},
): BoardCardView => ({
  id: `card-${number}`,
  number,
  label: `C-${number}`,
  title: `Card ${number}`,
  kind: 'feature',
  column,
  position: number,
  source: 'manual',
  issueNumber: null,
  issueUrl: null,
  prNumber: null,
  prUrl: null,
  round: null,
  design: null,
  continueAfterDesign: false,
  costUsd: null,
  captureWhy: null,
  captureConfidence: null,
  sourceSessionId: null,
  autoRunFailure: null,
  movedAt: '2026-10-14T10:00:00.000Z',
  completedAt: null,
  updatedAt: '2026-10-14T10:00:00.000Z',
  ...extra,
});

export const boardView = (cards: BoardCardView[]): BoardView => ({
  projectId: 'p1',
  columns: BOARD_COLUMNS.map((column) => ({
    column,
    cards: cards.filter((c) => c.column === column),
    hasMore: false,
  })),
  running: cards.filter(
    (c) =>
      c.round !== null &&
      ['queued', 'starting', 'running', 'waiting'].includes(c.round.phase),
  ).length,
  settings: {
    projectId: 'p1',
    issueOnRun: false,
    specOnRun: false,
    maxRunning: 3,
    captureEnabled: false,
    captureModel: 'haiku',
    isDefault: true,
    updatedAt: null,
  },
});

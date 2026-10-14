import {
  BOARD_MAX_RUNNING_DEFAULT,
  type BoardCardDetail,
  type BoardCardView,
  type BoardSettingsView,
  type BoardUserRef,
  CARD_HOOKS_GRACE_MS,
  type CardRoundBrief,
  type CardRoundView,
  cardLabel,
  isActiveRoundPhase,
} from '@agentdock/shared';
import {
  type BoardCard,
  type BoardCardRound,
  type BoardSettings,
  Prisma,
} from '@prisma/client';

/** A card with its rounds, newest first, as the board reads it. */
export type CardWithRounds = BoardCard & { rounds: BoardCardRound[] };

export type CardWithPeople = CardWithRounds & {
  createdBy: BoardUserRef | null;
  movedBy: BoardUserRef | null;
  completedBy: BoardUserRef | null;
  rounds: (BoardCardRound & { author: BoardUserRef | null })[];
};

/** What the mapper needs besides the rows. */
export interface CardFacts {
  /** Cost of each round's run, a decimal string; absent when nothing is priced. */
  costs: ReadonlyMap<string, string>;
  /** Card sessions a hook event has reached (the board sink claimed them). */
  hooked: ReadonlySet<string>;
  now: Date;
}

const iso = (date: Date | null): string | null => date?.toISOString() ?? null;

/**
 * D6: an active round older than the grace whose session no hook event ever
 * reached — the plugin's hooks are not installed where the worker runs.
 */
const hooksMissing = (
  card: BoardCard,
  round: BoardCardRound,
  facts: CardFacts,
): boolean =>
  isActiveRoundPhase(round.phase) &&
  facts.now.getTime() - round.startedAt.getTime() >= CARD_HOOKS_GRACE_MS &&
  !(card.sessionId !== null && facts.hooked.has(card.sessionId));

const brief = (
  card: BoardCard,
  round: BoardCardRound | undefined,
  facts: CardFacts,
): CardRoundBrief | null =>
  round
    ? {
        round: round.round,
        phase: round.phase,
        finishedBy: round.finishedBy,
        waitingAt: iso(round.waitingAt),
        hooksMissing: hooksMissing(card, round, facts),
      }
    : null;

/** The sum of the rounds' priced costs; `null` when none is priced. */
const cardCost = (
  rounds: readonly BoardCardRound[],
  costs: ReadonlyMap<string, string>,
): string | null => {
  let total: Prisma.Decimal | null = null;
  for (const round of rounds) {
    const cost = costs.get(round.runId);
    if (cost === undefined) continue;
    total = (total ?? new Prisma.Decimal(0)).plus(cost);
  }
  return total?.toFixed(6) ?? null;
};

export const toCardView = (
  card: CardWithRounds,
  facts: CardFacts,
): BoardCardView => ({
  id: card.id,
  number: card.number,
  label: cardLabel(card.number),
  title: card.title,
  kind: card.kind,
  column: card.column,
  position: card.position,
  source: card.source,
  issueNumber: card.issueNumber,
  issueUrl: card.issueUrl,
  prNumber: card.prNumber,
  prUrl: card.prUrl,
  round: brief(card, card.rounds[0], facts),
  costUsd: cardCost(card.rounds, facts.costs),
  movedAt: card.movedAt.toISOString(),
  completedAt: iso(card.completedAt),
  updatedAt: card.updatedAt.toISOString(),
});

const toRoundView = (
  card: BoardCard,
  round: BoardCardRound & { author: BoardUserRef | null },
  facts: CardFacts,
): CardRoundView => ({
  id: round.id,
  round: round.round,
  runId: round.runId,
  trigger: round.trigger,
  feedback: round.feedback,
  author: round.author,
  phase: round.phase,
  tmuxSession: round.tmuxSession,
  finishedBy: round.finishedBy,
  summary: round.summary,
  exitCode: round.exitCode,
  error: round.error,
  hooksMissing: hooksMissing(card, round, facts),
  costUsd: facts.costs.get(round.runId) ?? null,
  startedAt: round.startedAt.toISOString(),
  waitingAt: iso(round.waitingAt),
  finishedAt: iso(round.finishedAt),
  endedAt: iso(round.endedAt),
});

export const toCardDetail = (
  card: CardWithPeople,
  facts: CardFacts,
): BoardCardDetail => ({
  ...toCardView(card, facts),
  body: card.body,
  issueOnRun: card.issueOnRun,
  specOnRun: card.specOnRun,
  model: card.model,
  branch: card.branch,
  worktree: card.worktree,
  specPath: card.specPath,
  sessionId: card.sessionId,
  createdBy: card.createdBy,
  movedBy: card.movedBy,
  completedBy: card.completedBy,
  createdAt: card.createdAt.toISOString(),
  rounds: [...card.rounds]
    .sort((a, b) => a.round - b.round)
    .map((round) => toRoundView(card, round, facts)),
});

/** No row is the defaults (`isDefault: true`). */
export const toSettingsView = (
  projectId: string,
  row: BoardSettings | null,
): BoardSettingsView =>
  row
    ? {
        projectId,
        issueOnRun: row.issueOnRun,
        specOnRun: row.specOnRun,
        maxRunning: row.maxRunning,
        isDefault: false,
        updatedAt: row.updatedAt.toISOString(),
      }
    : {
        projectId,
        issueOnRun: false,
        specOnRun: false,
        maxRunning: BOARD_MAX_RUNNING_DEFAULT,
        isDefault: true,
        updatedAt: null,
      };

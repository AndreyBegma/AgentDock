import {
  type AttachmentView,
  BOARD_MAX_RUNNING_DEFAULT,
  type BoardCardDetail,
  type BoardCardView,
  type BoardSettingsView,
  type BoardUserRef,
  CAPTURE_MODEL_DEFAULT,
  CARD_HOOKS_GRACE_MS,
  type CardDependencyRef,
  type CardEvidenceView,
  type CardFleetView,
  type CardPullRequestRef,
  type CardRoundBrief,
  type CardRoundView,
  type CardTrackingView,
  cardAutoMergeDefault,
  cardCiChecksOf,
  cardLabel,
  cardRecommendationOf,
  FLEET_STAGES,
  type FleetStage,
  isActiveRoundPhase,
  isCaptureModel,
  isCardAutoRunCode,
  type TaskDesignSummary,
} from '@agentdock/shared';
import {
  type CardRunWiring,
  type CardRunWiringReason,
  cardRunWiringReasonSchema,
  cardRunWiringSchema,
} from '@agentdock/shared/protocol';
import {
  type BoardCard,
  type BoardCardPullRequest,
  type BoardCardRound,
  type BoardSettings,
  Prisma,
} from '@prisma/client';

/** #243: what a card's face shows of its design — the Design chip. */
export const cardDesignSelect = {
  select: {
    needed: true,
    suggested: true,
    suggestionWhy: true,
    variantCount: true,
    status: true,
    approvedRevisionId: true,
    busySince: true,
  },
} as const satisfies Prisma.BoardCard$designArgs;

type CardDesignRow = Prisma.TaskDesignGetPayload<typeof cardDesignSelect>;

/**
 * A card with its rounds, newest first, as the board reads it — and its
 * design's summary where the read asked for it.
 */
export type CardWithRounds = BoardCard & {
  rounds: BoardCardRound[];
  design?: CardDesignRow | null;
};

/** #243: the Design chip; `null` when the card has no design or it is off. */
const designOf = (
  design: CardDesignRow | null | undefined,
): TaskDesignSummary | null =>
  design?.needed
    ? { ...design, busySince: design.busySince?.toISOString() ?? null }
    : null;

export type CardWithPeople = CardWithRounds & {
  createdBy: BoardUserRef | null;
  movedBy: BoardUserRef | null;
  completedBy: BoardUserRef | null;
  rounds: (BoardCardRound & { author: BoardUserRef | null })[];
  /** #359 D8: the card's PRs, where the read included them; absent is none. */
  pullRequests?: BoardCardPullRequest[];
};

/** #359 D8: the card's PRs, oldest first. */
const pullRequestsOf = (
  rows: readonly BoardCardPullRequest[] | undefined,
): CardPullRequestRef[] =>
  [...(rows ?? [])]
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .map((pr) => ({
      number: pr.number,
      url: pr.url,
      branch: pr.branch,
      state: pr.state,
      round: pr.round,
      createdAt: pr.createdAt.toISOString(),
    }));

/** What the mapper needs besides the rows. */
export interface CardFacts {
  /** Cost of each round's run, a decimal string; absent when nothing is priced. */
  costs: ReadonlyMap<string, string>;
  /** Card sessions a hook event has reached (the board sink claimed them). */
  hooked: ReadonlySet<string>;
  /** #282 D1: tracked sessions (`sessions.id`) that have not ended. */
  alive: ReadonlySet<string>;
  /** #309: attachments of each card, its rounds' included; absent is none. */
  attachmentCounts: ReadonlyMap<string, number>;
  /** #337 D8: the cards each one runs after, in number order; absent is none. */
  dependencies: ReadonlyMap<string, CardDependencyRef[]>;
  now: Date;
}

/** #282 D1: a `terminal` card's session; `null` once the session row is gone. */
const trackingOf = (
  card: BoardCard,
  facts: CardFacts,
): CardTrackingView | null =>
  card.source === 'terminal' && card.trackedSessionId !== null
    ? {
        sessionId: card.trackedSessionId,
        alive: facts.alive.has(card.trackedSessionId),
      }
    : null;

const isFleetStage = (value: string): value is FleetStage =>
  (FLEET_STAGES as readonly string[]).includes(value);

/** #282 D4: a `fleet` card's slot, as the fleet projector wrote it. */
const fleetOf = (card: BoardCard): CardFleetView | null =>
  card.source === 'fleet' && card.fleetIssue !== null
    ? {
        issue: card.fleetIssue,
        slot: card.fleetSlot,
        stage:
          card.fleetStage !== null && isFleetStage(card.fleetStage)
            ? card.fleetStage
            : null,
        slotGone: card.fleetSlotGone,
      }
    : null;

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

/** #367 D3: a round's launch facts as stored (`null` until it started). */
export const wiringOf = (
  round: Pick<BoardCardRound, 'wiring' | 'wiringReason'>,
): {
  wiring: CardRunWiring | null;
  wiringReason: CardRunWiringReason | null;
} => {
  const wiring = cardRunWiringSchema.safeParse(round.wiring);
  if (!wiring.success) return { wiring: null, wiringReason: null };
  const reason = cardRunWiringReasonSchema.safeParse(round.wiringReason);
  return {
    wiring: wiring.data,
    wiringReason: wiring.data === 'none' && reason.success ? reason.data : null,
  };
};

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
        hooksCause: null,
        hooksProfile: null,
        ...wiringOf(round),
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
  kindSource: card.kindSource,
  column: card.column,
  position: card.position,
  source: card.source,
  issueNumber: card.issueNumber,
  issueUrl: card.issueUrl,
  prNumber: card.prNumber,
  prUrl: card.prUrl,
  prState: card.prState,
  collectState: card.collectState,
  collectError: card.collectState === 'failed' ? card.collectError : null,
  ciState: card.ciState,
  ciChecks: card.ciState === 'red' ? cardCiChecksOf(card.ciChecks) : [],
  ciFixAttempts: card.ciFixAttempts,
  needsPerson: card.needsPerson,
  mergedAt: iso(card.mergedAt),
  round: brief(card, card.rounds[0], facts),
  design: designOf(card.design),
  continueAfterDesign: card.continueAfterDesign,
  costUsd: cardCost(card.rounds, facts.costs),
  captureWhy: card.captureWhy,
  captureConfidence: card.captureConfidence,
  sourceSessionId: card.sourceSessionId,
  autoRunFailure:
    card.autoRunError !== null && card.autoRunFailedAt !== null
      ? {
          code: isCardAutoRunCode(card.autoRunError)
            ? card.autoRunError
            : 'unknown',
          message: card.autoRunMessage ?? '',
          at: card.autoRunFailedAt.toISOString(),
        }
      : null,
  tracking: trackingOf(card, facts),
  fleet: fleetOf(card),
  autoCollect: card.autoCollect,
  movedAt: card.movedAt.toISOString(),
  completedAt: iso(card.completedAt),
  updatedAt: card.updatedAt.toISOString(),
  attachmentCount: facts.attachmentCounts.get(card.id) ?? 0,
  dependsOn: facts.dependencies.get(card.id) ?? [],
  planId: card.planId,
});

const isEvidence = (value: Prisma.JsonValue): value is Prisma.JsonObject =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  typeof value.contentId === 'string' &&
  (value.kind === 'prompt' || value.kind === 'response') &&
  typeof value.excerpt === 'string';

/** #244 D8: `board_cards.evidence`; `null` when there is none. */
const evidenceOf = (
  json: Prisma.JsonValue | null,
): CardEvidenceView[] | null =>
  Array.isArray(json)
    ? json.filter(isEvidence).map((e) => ({
        contentId: String(e.contentId),
        kind: e.kind === 'prompt' ? 'prompt' : 'response',
        excerpt: String(e.excerpt),
      }))
    : null;

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
  hooksCause: null,
  hooksProfile: null,
  ...wiringOf(round),
  costUsd: facts.costs.get(round.runId) ?? null,
  startedAt: round.startedAt.toISOString(),
  waitingAt: iso(round.waitingAt),
  finishedAt: iso(round.finishedAt),
  endedAt: iso(round.endedAt),
});

/** `attachments`: the card's and its rounds', oldest first (#309). */
export const toCardDetail = (
  card: CardWithPeople,
  facts: CardFacts,
  attachments: AttachmentView[],
): BoardCardDetail => ({
  ...toCardView(card, facts),
  body: card.body,
  issueOnRun: card.issueOnRun,
  specOnRun: card.specOnRun,
  model: card.model,
  profileKey: card.profileKey,
  designModel: card.designModel,
  recommendation: cardRecommendationOf(card),
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
  pullRequests: pullRequestsOf(card.pullRequests),
  evidence: evidenceOf(card.evidence),
  attachments,
});

/**
 * No row is the defaults (`isDefault: true`). #359 D7: `baseBranch` is the
 * project's base and `defaultBranch` the repository's, where known
 * (`BoardProject.defaultBranch`); they decide `autoMergeCardsDefault`.
 * Without a base the default reads as off, the safe side.
 */
export const toSettingsView = (
  projectId: string,
  row: BoardSettings | null,
  baseBranch: string | null = null,
  defaultBranch: string | null = null,
): BoardSettingsView => {
  const autoMergeCardsDefault =
    baseBranch !== null && cardAutoMergeDefault(baseBranch, defaultBranch);
  return row
    ? {
        projectId,
        issueOnRun: row.issueOnRun,
        specOnRun: row.specOnRun,
        maxRunning: row.maxRunning,
        captureEnabled: row.captureEnabled,
        captureModel: isCaptureModel(row.captureModel)
          ? row.captureModel
          : CAPTURE_MODEL_DEFAULT,
        autoCollectTracked: row.autoCollectTracked,
        autoMergeCards: row.autoMergeCards,
        autoMergeCardsDefault,
        isDefault: false,
        updatedAt: row.updatedAt.toISOString(),
      }
    : {
        projectId,
        issueOnRun: false,
        specOnRun: false,
        maxRunning: BOARD_MAX_RUNNING_DEFAULT,
        captureEnabled: false,
        captureModel: CAPTURE_MODEL_DEFAULT,
        autoCollectTracked: false,
        autoMergeCards: null,
        autoMergeCardsDefault,
        isDefault: true,
        updatedAt: null,
      };
};

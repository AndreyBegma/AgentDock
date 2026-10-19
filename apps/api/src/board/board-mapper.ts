import {
  type AttachmentView,
  BOARD_MAX_RUNNING_DEFAULT,
  type BoardCardDetail,
  type BoardCardView,
  type BoardSettingsView,
  type BoardUserRef,
  CAPTURE_MODEL_DEFAULT,
  CARD_BACKGROUND_STALL_MINUTES_DEFAULT,
  CARD_HOOKS_GRACE_MS,
  type CardDependencyRef,
  type CardEvidenceView,
  type CardFleetView,
  type CardHooksCause,
  type CardPrTarget,
  type CardPullRequestRef,
  type CardRoundBrief,
  type CardRoundView,
  type CardStackRef,
  type CardTrackingView,
  cardAutoMergeDefault,
  cardCiChecksOf,
  cardLabel,
  cardReadiness,
  cardRecommendationOf,
  FLEET_STAGES,
  type FleetStage,
  isActiveRoundPhase,
  isCaptureModel,
  isCardAutoRunCode,
  isCardNeedsPersonReason,
  type PendingQuestion,
  pendingQuestionSchema,
  type RestartEstimate,
  restartEstimateSchema,
  type StewardCardChip,
  type TaskDesignSummary,
  type TokenSavedView,
} from '@agentdock/shared';
import {
  type CardRunWiring,
  type CardRunWiringReason,
  cardRunWiringReasonSchema,
  cardRunWiringSchema,
  type LocalErrorCode,
  localErrorCodeSchema,
  type PaneDialog,
  type ProfileAgentdock,
  paneDialogSchema,
} from '@agentdock/shared/protocol';
import {
  type BoardCard,
  type BoardCardPullRequest,
  type BoardCardRound,
  type BoardSettings,
  Prisma,
} from '@prisma/client';
import type { TokenSaverCardFacts } from '../token-saver/token-saver-facts';

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

/**
 * #636: where a card's PR goes — the dependency's branch it is stacked on
 * (`stackedOn` its number, when known), else the project base; `null` before
 * the card has a branch.
 */
export const prTargetOf = (
  card: Pick<BoardCard, 'branch' | 'prBase'>,
  stackedOn: number | null,
  projectBase: string,
): CardPrTarget | null => {
  if (card.branch === null) return null;
  if (card.prBase === null) return { branch: projectBase, stackedOn: null };
  return {
    branch: card.prBase,
    stackedOn:
      stackedOn === null
        ? null
        : { number: stackedOn, label: cardLabel(stackedOn) },
  };
};

/** What the mapper needs besides the rows. */
export interface CardFacts {
  /** Cost of each round's run, a decimal string; absent when nothing is priced. */
  costs: ReadonlyMap<string, string>;
  /** Card sessions a hook event has reached (the board sink claimed them). */
  hooked: ReadonlySet<string>;
  /** #282 D1: tracked sessions (`sessions.id`) that have not ended. */
  alive: ReadonlySet<string>;
  /** #348 D1: each round's run profile key (`runs.profileKey`); absent is none. */
  runProfileKeys: ReadonlyMap<string, string>;
  /** #348 D1: each project's runner reports, by profile key (`profileAgentdockOf`). */
  profileAgentdock: ReadonlyMap<string, Record<string, ProfileAgentdock>>;
  /** #309: attachments of each card, its rounds' included; absent is none. */
  attachmentCounts: ReadonlyMap<string, number>;
  /** #337 D8: the cards each one runs after, in number order; absent is none. */
  dependencies: ReadonlyMap<string, CardDependencyRef[]>;
  /** #445: each round run's savings estimate and artifact-guard flag. */
  tokenSaver: TokenSaverCardFacts;
  /**
   * #447 D15: the live Steward incident of each round, by round id
   * (`StewardChips.forRounds`); absent is none.
   */
  steward?: ReadonlyMap<string, StewardCardChip>;
  /**
   * #449 D9: what each `fresh` round's start saved, a decimal string, by
   * round id (`restartSavingsFor`); absent is none.
   */
  restartSavings?: ReadonlyMap<string, string>;
  /** #480: each card's stack, by card id; absent is none. */
  stacks?: ReadonlyMap<string, CardStackRef>;
  /** #636: where each card's PR goes, by card id; absent is not known. */
  prTargets?: ReadonlyMap<string, CardPrTarget>;
  now: Date;
}

/**
 * #449 D9: the card chip's facts — how the latest round's session started
 * and, after a `fresh` start, what it saved.
 */
export const restartOf = (
  card: CardWithRounds,
  facts: Pick<CardFacts, 'restartSavings'>,
): Pick<BoardCardView, 'restartMode' | 'warmupSavedUsd'> => {
  const latest = card.rounds[0];
  return {
    restartMode: latest?.restartMode ?? null,
    warmupSavedUsd:
      latest?.restartMode === 'fresh'
        ? (facts.restartSavings?.get(latest.id) ?? null)
        : null,
  };
};

/** #449 D3: the round's stored estimates; `null` when none or unreadable. */
const restartEstimateOf = (
  json: Prisma.JsonValue | null,
): RestartEstimate | null => {
  const parsed = restartEstimateSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
};

/** #447 D15: the chip of the card's latest round's live incident. */
export const stewardChipOf = (
  card: CardWithRounds,
  facts: Pick<CardFacts, 'steward'>,
): StewardCardChip | null => {
  const latest = card.rounds[0];
  return latest ? (facts.steward?.get(latest.id) ?? null) : null;
};

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

/**
 * #348 D1: why hooks are missing, and for which profile. `null` cause when they
 * are not missing; `unknown` when the run has no profile key, the runner
 * reports no such profile, or the profile has no `agentdock` field.
 */
export const hooksCauseOf = (
  card: BoardCard,
  round: BoardCardRound,
  facts: CardFacts,
): {
  hooksCause: CardHooksCause | null;
  hooksProfile: string | null;
} => {
  if (!hooksMissing(card, round, facts)) {
    return { hooksCause: null, hooksProfile: null };
  }
  const hooksProfile = facts.runProfileKeys.get(round.runId) ?? null;
  const report =
    hooksProfile === null
      ? undefined
      : facts.profileAgentdock.get(card.projectId)?.[hooksProfile];
  const hooksCause: CardHooksCause =
    report === undefined
      ? 'unknown'
      : report.plugin === null
        ? 'no_plugin'
        : 'session_predates';
  return { hooksCause, hooksProfile };
};

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

/** #482: a refused `finish_card` counts only while the round is active. */
export const finishRefusedOf = (
  round: Pick<BoardCardRound, 'phase' | 'finishRefusedCode'>,
): LocalErrorCode | null => {
  if (!isActiveRoundPhase(round.phase)) return null;
  const code = localErrorCodeSchema.safeParse(round.finishRefusedCode);
  return code.success ? code.data : null;
};

/** #624: the dialog that blocks a round counts only while it waits. */
export const blockingDialogOf = (
  round: Pick<BoardCardRound, 'phase' | 'blockingDialog'>,
): PaneDialog | null => {
  if (round.phase !== 'waiting') return null;
  const dialog = paneDialogSchema.safeParse(round.blockingDialog);
  return dialog.success ? dialog.data : null;
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
        backgroundAt: iso(round.backgroundAt),
        backgroundCommand: round.backgroundCommand,
        hooksMissing: hooksMissing(card, round, facts),
        ...hooksCauseOf(card, round, facts),
        ...wiringOf(round),
        autoRunAfter: round.autoRunAfter,
        pendingQuestion: pendingQuestionOf(round),
        finishRefused: finishRefusedOf(round),
        blockingDialog: blockingDialogOf(round),
      }
    : null;

/** #489 M4: an active round's question screen, as the runner reported it. */
export const pendingQuestionOf = (
  round: BoardCardRound,
): PendingQuestion | null => {
  if (!isActiveRoundPhase(round.phase) || round.pendingQuestion === null) {
    return null;
  }
  const parsed = pendingQuestionSchema.safeParse(round.pendingQuestion);
  return parsed.success ? parsed.data : null;
};

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

/** #445 D13: the rounds' estimates summed, as `cardCost`; `null` when none. */
const cardTokenSaved = (
  rounds: readonly BoardCardRound[],
  saved: TokenSaverCardFacts['tokenSaved'],
): TokenSavedView | null => {
  const of = rounds.flatMap((round) => saved.get(round.runId) ?? []);
  if (of.length === 0) return null;
  return {
    estimateTokens: of.reduce((sum, s) => sum + s.estimateTokens, 0),
    estimateUsd: of.reduce((sum, s) => sum + s.estimateUsd, 0),
  };
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
  needsPersonReason:
    card.needsPerson &&
    card.needsPersonReason !== null &&
    isCardNeedsPersonReason(card.needsPersonReason)
      ? card.needsPersonReason
      : null,
  mergedAt: iso(card.mergedAt),
  prTarget: facts.prTargets?.get(card.id) ?? null,
  round: brief(card, card.rounds[0], facts),
  design: designOf(card.design),
  continueAfterDesign: card.continueAfterDesign,
  costUsd: cardCost(card.rounds, facts.costs),
  tokenSaved: cardTokenSaved(card.rounds, facts.tokenSaver.tokenSaved),
  // #445 D8: the latest round's finish.
  artifactIncomplete:
    card.rounds[0] !== undefined &&
    facts.tokenSaver.artifactIncomplete.has(card.rounds[0].runId),
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
          after: card.autoRunAfter,
          stack: card.autoRunStack,
        }
      : null,
  autoRunWhenReady: card.autoRunWhenReady,
  readiness: cardReadiness(card.column, facts.dependencies.get(card.id) ?? []),
  stack: facts.stacks?.get(card.id) ?? null,
  tracking: trackingOf(card, facts),
  fleet: fleetOf(card),
  autoCollect: card.autoCollect,
  movedAt: card.movedAt.toISOString(),
  completedAt: iso(card.completedAt),
  updatedAt: card.updatedAt.toISOString(),
  attachmentCount: facts.attachmentCounts.get(card.id) ?? 0,
  dependsOn: facts.dependencies.get(card.id) ?? [],
  planId: card.planId,
  steward: stewardChipOf(card, facts),
  ...restartOf(card, facts),
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
  ...hooksCauseOf(card, round, facts),
  ...wiringOf(round),
  autoRunAfter: round.autoRunAfter,
  finishRefused: finishRefusedOf(round),
  blockingDialog: blockingDialogOf(round),
  costUsd: facts.costs.get(round.runId) ?? null,
  tokenSaved: facts.tokenSaver.tokenSaved.get(round.runId) ?? null,
  tokenSaverFilters: facts.tokenSaver.tokenSaverFilters.get(round.runId) ?? [],
  artifactIncomplete: facts.tokenSaver.artifactIncomplete.has(round.runId),
  startedAt: round.startedAt.toISOString(),
  waitingAt: iso(round.waitingAt),
  backgroundAt: iso(round.backgroundAt),
  backgroundCommand: round.backgroundCommand,
  finishedAt: iso(round.finishedAt),
  endedAt: iso(round.endedAt),
  restartMode: round.restartMode,
  restartEstimate: restartEstimateOf(round.restartEstimate),
  warmupTokens: round.warmupTokens,
  warmupMs: round.warmupMs,
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
  specPr:
    card.specRepo !== null &&
    card.specPrNumber !== null &&
    card.specPrUrl !== null
      ? {
          repo: card.specRepo,
          number: card.specPrNumber,
          url: card.specPrUrl,
        }
      : null,
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
        backgroundStallMinutes: row.backgroundStallMinutes,
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
        backgroundStallMinutes: CARD_BACKGROUND_STALL_MINUTES_DEFAULT,
        isDefault: true,
        updatedAt: null,
      };
};

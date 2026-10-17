import {
  BOARD_COLUMNS,
  BOARD_ERROR,
  BOARD_MAX_RUNNING_MAX,
  BOARD_MAX_RUNNING_MIN,
  type BoardCardView,
  type BoardColumn,
  type BoardMoveRefusal,
  type BoardView,
  CARD_BACKGROUND_STALL_MINUTES_MAX,
  CARD_BACKGROUND_STALL_MINUTES_MIN,
  type CaptureModel,
  type CaptureSkipReason,
  type CaptureStatus,
  type CardCaptureView,
  type CardRoundBrief,
  type CardRoundPhase,
  isActiveRoundPhase,
  isMirroredCardSource,
  PLAN_TASK_MOVE_REFUSAL_TEXT,
} from '@agentdock/shared';
import type {
  CardRunWiringReason,
  LocalErrorCode,
} from '@agentdock/shared/protocol';
import type { Status } from '@andrewbehma/glass-ui/status-pill';
import { describePolicyRefusal } from '@/lib/runners/policy';
import { ApiError, describeError } from '../api';
import { STAGE_LABEL } from '../fleet/graph';
import { describeNoProfile } from '../readiness/copy';
import {
  PROFILES_LIST_COMMAND,
  RUNNER_STATUS_COMMAND,
  SETUP_CLAUDE_COMMAND,
} from '../runners/install';
import { noPrText } from './pull-request';

export const COLUMN_TITLE: Record<BoardColumn, string> = {
  inbox: 'Inbox',
  todo: 'To Do',
  in_progress: 'In progress',
  finished: 'Finished',
  completed: 'Completed',
};

export const COLUMN_HINT: Record<BoardColumn, string> = {
  inbox: 'Suggested from your sessions. Accept or dismiss.',
  todo: 'Waiting for a worker.',
  in_progress: 'A worker is on it.',
  finished: 'Review it, send it back or accept it.',
  completed: 'Accepted.',
};

export interface RoundPill {
  status: Status;
  label: string;
}

const PHASE_PILL: Record<CardRoundPhase, RoundPill> = {
  queued: { status: 'running', label: 'Queued' },
  starting: { status: 'running', label: 'Starting' },
  running: { status: 'running', label: 'Running' },
  waiting: { status: 'waiting', label: 'Waiting for you' },
  // #390: the worker waits on its own background task, not on the person.
  background: { status: 'running', label: 'Running in background' },
  finished: { status: 'done', label: 'Finished' },
  ended: { status: 'blocked', label: 'Ended' },
  failed: { status: 'error', label: 'Failed' },
  cancelled: { status: 'idle', label: 'Stopped' },
};

export const phaseLabel = (phase: CardRoundPhase): string =>
  PHASE_PILL[phase].label;

/**
 * The pill a card wears for its latest round; none before the first Run. A
 * finished round is not shown on the board: the column already says it.
 */
export function roundPill(round: CardRoundBrief | null): RoundPill | null {
  if (!round || round.phase === 'finished') return null;
  // #482: a refused finish_card leaves the round active, not done.
  if (round.finishRefused && isActiveRoundPhase(round.phase)) {
    return { status: 'error', label: 'Needs attention' };
  }
  return PHASE_PILL[round.phase];
}

const FINISH_REFUSED_REASON: Partial<Record<LocalErrorCode, string>> = {
  not_a_card_session:
    'AgentDock did not recognise the worker’s session as this card’s — the runner may have restarted.',
  runner_offline: 'the runner could not reach AgentDock.',
  daemon_unavailable: 'the runner was not running.',
  timeout: 'AgentDock did not answer in time.',
  forbidden: 'the runner’s user may not finish cards in this project.',
  no_project: 'the worker’s folder is in no watched project.',
};

/**
 * #482: why the round needs attention — the worker's `finish_card` was
 * refused. Ask the worker to call it again, or finish the card yourself.
 */
export const finishRefusedText = (code: LocalErrorCode): string =>
  `finish_card was refused: ${FINISH_REFUSED_REASON[code] ?? `${code.replaceAll('_', ' ')}.`} Ask the worker to call it again, or finish the card yourself.`;

export const isRoundActive = (round: CardRoundBrief | null): boolean =>
  isActiveRoundPhase(round?.phase);

/** One card as glass-ui's `Board` takes it: `label` is the accessible name. */
export interface BoardItem {
  id: string;
  label: string;
  card: BoardCardView;
}

export const toItem = (card: BoardCardView): BoardItem => ({
  id: card.id,
  label: `${card.label} ${card.title}`,
  card,
});

export const findCard = (
  view: BoardView,
  cardId: string,
): BoardCardView | undefined => {
  for (const column of view.columns) {
    const hit = column.cards.find((card) => card.id === cardId);
    if (hit) return hit;
  }
  return undefined;
};

export const cardByNumber = (
  view: BoardView,
  number: number,
): BoardCardView | undefined => {
  for (const column of view.columns) {
    const hit = column.cards.find((card) => card.number === number);
    if (hit) return hit;
  }
  return undefined;
};

/** The wire name of the `?card=` parameter. */
export const parseCardParam = (raw: string | null): number | undefined => {
  if (raw === null || !/^\d{1,9}$/.test(raw)) return undefined;
  const n = Number(raw);
  return n > 0 ? n : undefined;
};

/**
 * Every column in `BOARD_COLUMNS` order, even if the API left one out — except
 * Inbox, which the API leaves out on purpose for a viewer (#244 D8).
 */
export const columnsOf = (view: BoardView) =>
  BOARD_COLUMNS.filter(
    (column) =>
      column !== 'inbox' || view.columns.some((c) => c.column === column),
  ).map(
    (column) =>
      view.columns.find((c) => c.column === column) ?? {
        column,
        cards: [],
        hasMore: false,
      },
  );

export const MOVE_REFUSAL_TEXT: Record<BoardMoveRefusal, string> = {
  card_running:
    'A worker is running on this card. Stop it first, or mark the card finished.',
  automatic_to_completed: 'Only a person completes a card.',
  card_completed: 'This card is already completed.',
  invalid_move: 'A suggestion leaves the Inbox only by Accept, into To Do.',
  plan_task_derived: PLAN_TASK_MOVE_REFUSAL_TEXT,
  fleet_slot: 'A fleet card follows its slot. Accept it once it is finished.',
};

/** #273 D7: the card's design is on and not approved, so the server would refuse Run. */
export const designBlocksRun = (card: BoardCardView): boolean =>
  card.design?.needed === true && card.design.status !== 'approved';

export const isTerminalCard = (card: BoardCardView): boolean =>
  card.source === 'terminal';

export const isFleetCard = (card: BoardCardView): boolean =>
  card.source === 'fleet';

/** #282 D1: the tracked terminal session is alive — it is the worker. */
export const isSessionAlive = (card: BoardCardView): boolean =>
  card.tracking?.alive === true;

/**
 * #282 D1/D4: the board starts, stops and answers a worker only for a card
 * that owns one. A `fleet` card's worker is the orchestrator's; a `terminal`
 * card's is the person's own session while it lives.
 */
export const ownsWorker = (card: BoardCardView): boolean =>
  !isFleetCard(card) && !isSessionAlive(card);

export const canRun = (card: BoardCardView): boolean =>
  ownsWorker(card) &&
  (card.column === 'todo' || card.column === 'finished') &&
  !isRoundActive(card.round) &&
  !designBlocksRun(card);

export const canGiveFeedback = (card: BoardCardView): boolean =>
  ownsWorker(card) && card.column === 'finished' && !isRoundActive(card.round);

export const canAccept = (card: BoardCardView): boolean =>
  card.column === 'finished' && !isRoundActive(card.round);

/** A retry after a failed, ended or stopped round resumes the same session. */
export const canRetry = (card: BoardCardView): boolean =>
  ownsWorker(card) &&
  card.column === 'in_progress' &&
  card.round !== null &&
  !isRoundActive(card.round) &&
  !designBlocksRun(card);

/** #282 D4: a `fleet` card follows its slot, so a person cannot delete it. */
export const canDelete = (card: BoardCardView): boolean => !isFleetCard(card);

/** #282 D1: the card's session page; `null` when it is not a terminal card. */
export const trackedSessionHref = (card: BoardCardView): string | null =>
  card.tracking ? sessionHref(card.tracking.sessionId) : null;

export const TRACKED_TEXT = 'Tracked from a terminal session';

export const trackedStatusText = (card: BoardCardView): string =>
  isSessionAlive(card)
    ? 'The session is running; the card finishes when it ends.'
    : 'The session has ended.';

export const AUTO_COLLECT_LABEL =
  'Automatic work: push and open a pull request when it finishes';

export const AUTO_COLLECT_HINT =
  'Off, nothing is pushed: the card only records the branch and the session.';

/** The project default for a new terminal card (#282 D3). */
export const AUTO_COLLECT_DEFAULT_LABEL =
  'Automatic work for terminal sessions';

export const AUTO_COLLECT_DEFAULT_HINT =
  'What a card tracked from a terminal session starts with: push and open a pull request when its session ends. A card can override it. Off by default.';

/** The Fleet page with the card's slot open; none for an issue no slot picked up. */
export const fleetHref = (
  projectId: string,
  card: BoardCardView,
): string | null =>
  card.fleet?.slot
    ? `/projects/${projectId}/fleet?open=${encodeURIComponent(card.fleet.slot)}&focus=${encodeURIComponent(card.fleet.slot)}`
    : null;

/** One line for a fleet card: the slot (or "Waiting for a slot") and its stage. */
export function fleetSummary(
  fleet: NonNullable<BoardCardView['fleet']>,
): string {
  const slot = fleet.slot ?? 'Waiting for a slot';
  return fleet.stage ? `${slot} · ${STAGE_LABEL[fleet.stage]}` : slot;
}

export const SLOT_GONE_TEXT = 'Slot gone';

export const FLEET_EDIT_HINT =
  'Title and text only. An edit reaches the running slot; the GitHub issue is not changed.';

export const FLEET_ACCEPT_REASON =
  'A fleet card is not merged here: the orchestrator merges its pull request.';

/** #273 D7: **Approve & run** takes Run's place while the design blocks it. */
export interface ApproveRunOffer {
  enabled: boolean;
  /** Why it is disabled; `null` when enabled. */
  reason: string | null;
}

/**
 * Where Run would be, the card's design is not approved: the offer is a link
 * to the viewer, enabled only once there is a design to approve (`reviewing`).
 */
export function approveRunOffer(card: BoardCardView): ApproveRunOffer | null {
  if (!designBlocksRun(card) || !ownsWorker(card)) return null;
  const startable =
    (card.column === 'todo' ||
      card.column === 'finished' ||
      (card.column === 'in_progress' && card.round !== null)) &&
    !isRoundActive(card.round);
  if (!startable) return null;
  return card.design?.status === 'reviewing'
    ? { enabled: true, reason: null }
    : { enabled: false, reason: 'The design is being drawn' };
}

export const canStop = (card: BoardCardView): boolean =>
  ownsWorker(card) && isRoundActive(card.round);

export const canMarkFinished = (card: BoardCardView): boolean =>
  ownsWorker(card) &&
  card.column === 'in_progress' &&
  isRoundActive(card.round);

/** #244 D9: an Inbox card is accepted or dismissed, never run. */
export const isSuggestion = (card: BoardCardView): boolean =>
  card.column === 'inbox';

/** The confidence as a whole percent: `0.74` → `74%`; none for a manual card. */
export const confidenceLabel = (confidence: number | null): string | null =>
  confidence === null || !Number.isFinite(confidence)
    ? null
    : `${Math.round(Math.min(Math.max(confidence, 0), 1) * 100)}%`;

/** The source session's page (its content timeline); none once the session is gone. */
export const sessionHref = (sessionId: string | null): string | null =>
  sessionId === null ? null : `/sessions/${encodeURIComponent(sessionId)}`;

export const CAPTURE_STATUS_PILL: Record<CaptureStatus, RoundPill> = {
  queued: { status: 'idle', label: 'Queued' },
  running: { status: 'running', label: 'Running' },
  succeeded: { status: 'done', label: 'Done' },
  failed: { status: 'error', label: 'Failed' },
  skipped: { status: 'blocked', label: 'Skipped' },
};

export const CAPTURE_SKIP_TEXT: Record<CaptureSkipReason, string> = {
  too_little: 'Too little new content',
  rate_limited: 'Rate limit reached',
  inbox_full: 'Inbox is full',
  budget_exceeded: 'Budget hard stop',
  runner_offline: 'Runner was offline',
  capture_off: 'Capture was turned off',
  no_profile: 'No runtime profile',
  tracked: 'Session tracks a card',
};

/** What a capture row says about its outcome: the skip reason, the error, or the count. */
export function captureOutcome(capture: CardCaptureView): string {
  if (capture.status === 'skipped' && capture.skipReason) {
    return CAPTURE_SKIP_TEXT[capture.skipReason];
  }
  if (capture.status === 'failed') return capture.error ?? 'Failed';
  if (capture.status === 'succeeded') {
    return capture.suggested === 1
      ? '1 card suggested'
      : `${capture.suggested} cards suggested`;
  }
  return '';
}

export const CAPTURE_MODEL_LABEL: Record<CaptureModel, string> = {
  haiku: 'Haiku (fast, cheap)',
  sonnet: 'Sonnet (better judgement, dearer)',
};

/** Shown beside the Capture toggle: content goes to a model on the runner. */
export const CAPTURE_WARNING =
  'While capture is on, the prompts and final responses of your manual Claude Code sessions are sent to a small model on this project’s runner, which proposes cards. Tool inputs and outputs are never used. Suggestions are visible to operators only; accepting one drops the evidence and keeps the link to its session.';

const errorCode = (error: unknown): string | undefined =>
  error instanceof ApiError ? error.code : undefined;

export const isNotFound = (error: unknown): boolean =>
  error instanceof ApiError && error.status === 404;

/** #273 D13: a refused merge, by `reason`; `message` is the runner's one line. */
export function describeMergeFailure(
  reason: unknown,
  message?: unknown,
): string {
  switch (reason) {
    case 'head_changed':
      return 'The branch changed since you opened this — review it again.';
    case 'not_mergeable':
      return 'GitHub refuses the merge: checks or branch protection.';
    case 'closed':
      return 'The pull request is closed.';
    default:
      return typeof message === 'string' && message !== ''
        ? `gh failed: ${message}`
        : 'gh failed to merge the pull request.';
  }
}

/** #329 D8: the runner refused to close the PR; the card stays in Finished. */
export function describePrCloseFailure(
  reason: unknown,
  message?: unknown,
): string {
  if (reason === 'merged') {
    return 'The pull request was merged meanwhile, so it cannot be closed. Open the dialog again.';
  }
  return typeof message === 'string' && message !== ''
    ? `gh failed to close the pull request: ${message}`
    : 'gh failed to close the pull request.';
}

/**
 * #273 D9: why approving the design did not start the worker. The codes that
 * need no detail read like the same refusal on Run; any other falls back to
 * the server's message.
 */
export function autoRunReason(
  failure: NonNullable<BoardCardView['autoRunFailure']>,
): string {
  switch (failure.code) {
    case BOARD_ERROR.maxRunning:
    case BOARD_ERROR.budgetExceeded:
    case BOARD_ERROR.noSpecDir:
    case BOARD_ERROR.unsupportedRuntime:
    case BOARD_ERROR.cardRunning:
    case BOARD_ERROR.commandUnavailable:
      // `ApiError.code` is typed for auth codes; a board code travels in it too.
      return describeBoardError(
        new ApiError(
          409,
          failure.code as ApiError['code'],
          failure.message,
          undefined,
          null,
        ),
      ).replace(/\.$/, '');
    default:
      return failure.message.replace(/\.$/, '');
  }
}

/**
 * #273 D9, #443: what the face's "Didn’t start" says — the design approval's
 * start, or Auto-run when ready's after a dependency was accepted.
 */
export function autoRunFailureText(
  failure: NonNullable<BoardCardView['autoRunFailure']>,
): string {
  const reason = autoRunReason(failure);
  return failure.after != null
    ? `Auto-run after C-${failure.after} was accepted could not start: ${reason}`
    : `Design approved — the worker did not start: ${reason}`;
}

/** Every board error as a sentence for the person; the server's text last. */
export function describeBoardError(
  error: unknown,
  runnerName?: string | null,
): string {
  switch (errorCode(error)) {
    case BOARD_ERROR.cardRunning:
      return 'A worker is running on this card. Stop it or mark it finished first.';
    case BOARD_ERROR.maxRunning:
      return 'This project already runs its limit of workers. Wait for one to finish, or raise the limit in the project settings.';
    case BOARD_ERROR.budgetExceeded:
      return 'A budget with a hard stop refuses another round.';
    case BOARD_ERROR.moveRefused: {
      const reason = error instanceof ApiError ? error.body?.reason : undefined;
      return typeof reason === 'string' && reason in MOVE_REFUSAL_TEXT
        ? MOVE_REFUSAL_TEXT[reason as BoardMoveRefusal]
        : 'That move is not allowed.';
    }
    case BOARD_ERROR.notRunning:
      return 'No worker is running on this card any more.';
    case BOARD_ERROR.wrongColumn:
      return 'The card is not in the column this needs. Refresh the board.';
    case BOARD_ERROR.noSpecDir:
      return 'This project has no spec directory, so a spec cannot be written. Turn the spec off, or set the docs source in the project settings.';
    case BOARD_ERROR.unsupportedRuntime:
      return 'The runner refused: card workers run on Claude profiles only.';
    case BOARD_ERROR.noProfile:
      return describeNoProfile(error);
    case BOARD_ERROR.designNotApproved:
      return 'This card’s design is on and not approved yet. Open the design and approve it, or approve and run from there.';
    case BOARD_ERROR.designApproved:
      return 'The design is approved, so “Continue after design” can no longer change.';
    case BOARD_ERROR.policyRefused:
      return describePolicyRefusal(
        error instanceof ApiError ? error.message : null,
      );
    case BOARD_ERROR.commandUnavailable:
      return `The runner${runnerName ? ` ${runnerName}` : ''} is offline or too old to run card workers.`;
    case BOARD_ERROR.invalidMove:
      return MOVE_REFUSAL_TEXT.invalid_move;
    case BOARD_ERROR.captureNeedsContent:
      return 'Capture reads session content. Turn on “Keep session content” in the Sessions tab first.';
    case BOARD_ERROR.mergeFailed: {
      const body = error instanceof ApiError ? error.body : null;
      return describeMergeFailure(body?.reason, body?.message);
    }
    case BOARD_ERROR.prCloseFailed: {
      const body = error instanceof ApiError ? error.body : null;
      return describePrCloseFailure(body?.reason, body?.message);
    }
    case BOARD_ERROR.branchDeleteRefused:
      return 'A terminal card’s branch is your session branch, so AgentDock does not delete it.';
    case BOARD_ERROR.noBranch:
      return 'This card never ran, so there is no branch to open a pull request from.';
    case BOARD_ERROR.noPullRequest:
      return 'This card has no pull request to merge.';
    case BOARD_ERROR.notTracked:
      return 'Automatic work belongs to cards tracked from a terminal session.';
    case BOARD_ERROR.dependencyCycle:
      return 'That would make the cards wait for each other in a circle.';
    case BOARD_ERROR.invalidDependency:
      return 'A card cannot depend on itself, or on a number that is no card of this project.';
    case BOARD_ERROR.dependencyOpen:
      return 'A card it depends on is not completed yet.';
    default:
      break;
  }
  if (error instanceof ApiError && error.status === 404) {
    return 'That card or project no longer exists, or you are not a member of it.';
  }
  if (error instanceof ApiError && error.status === 403) {
    return 'Only operators can do this.';
  }
  return describeError(error);
}

/** The settings field: a whole number in the allowed range, else `null`. */
export function parseMaxRunning(raw: string): number | null {
  if (!/^\d{1,3}$/.test(raw.trim())) return null;
  const n = Number(raw.trim());
  return n >= BOARD_MAX_RUNNING_MIN && n <= BOARD_MAX_RUNNING_MAX ? n : null;
}

/** #390: the background stall threshold field, in minutes; null when out of range. */
export function parseStallMinutes(raw: string): number | null {
  if (!/^\d{1,4}$/.test(raw.trim())) return null;
  const n = Number(raw.trim());
  return n >= CARD_BACKGROUND_STALL_MINUTES_MIN &&
    n <= CARD_BACKGROUND_STALL_MINUTES_MAX
    ? n
    : null;
}

const HOOKS_CONSEQUENCE =
  'the card moves only when the session ends or you mark it finished.';

/** #367 D3: why a round launched by the runner reports no hooks. */
const WIRING_REASON_TEXT: Record<CardRunWiringReason, string> = {
  runner_outdated: `The runner that started this round is older than 0.10.0, so it did not add AgentDock hooks to the session; ${HOOKS_CONSEQUENCE} Update the runner, then run the card again.`,
  settings_write_failed: `The runner could not write this round's hook settings, so the session started without AgentDock hooks; ${HOOKS_CONSEQUENCE} Check the runner's log and the disk it writes to, then run the card again.`,
  claude_too_old: `The Claude Code on this runner does not accept --settings, so the session started without AgentDock hooks; ${HOOKS_CONSEQUENCE} Update Claude Code, then run the card again.`,
};

/** The profile placeholder of `SETUP_CLAUDE_COMMAND`. */
const PROFILE_PLACEHOLDER = '<key>';

/** The setup commands of a terminal or fleet card, naming its profile if known. */
const setupCommands = (profileKey: string | null) =>
  profileKey
    ? ([
        {
          label: `Set up profile ${profileKey}, then restart its sessions`,
          code: SETUP_CLAUDE_COMMAND.replace(PROFILE_PLACEHOLDER, profileKey),
        },
      ] as const)
    : ([
        {
          label: 'Find the profile key (first column)',
          code: PROFILES_LIST_COMMAND,
        },
        {
          label: 'Set up that profile, then restart its sessions',
          code: SETUP_CLAUDE_COMMAND,
        },
      ] as const);

export interface HooksNotice {
  /** The hint, in prose with no markdown. */
  text: string;
  /** The chip on the card's face. */
  chip: string;
  /** Commands shown as code blocks next to the hint. */
  commands: readonly { label: string; code: string }[];
  /** Whether the Settings › Sessions checklist is the way out. */
  guide: boolean;
}

/**
 * #281 D6, #367 D3/D4: what a card says when no hook event arrived after the
 * start. A card the runner launches is wired by the runner, so it names the
 * round's launch facts, never "set up the plugin"; a terminal or fleet card
 * runs outside the runner and keeps the plugin's setup commands, for its own
 * profile when the card knows it.
 */
export const hooksNotice = (
  card: Pick<BoardCardView, 'source'> & { profileKey?: string | null },
  round: Pick<CardRoundBrief, 'wiring' | 'wiringReason'> &
    Pick<Partial<CardRoundBrief>, 'hooksCause' | 'hooksProfile'>,
): HooksNotice => {
  const { wiring = null, wiringReason = null, hooksCause = null } = round;
  // #348 D1/D2: the plugin state of the round's profile. Launch facts the
  // runner reported (no hooks, or its own injected settings) outrank it.
  const profile = round.hooksProfile ?? card.profileKey ?? null;
  if (profile && wiring !== 'none' && wiring !== 'injected') {
    if (hooksCause === 'no_plugin') {
      return {
        text: `No hook events from this card's session: the agentdock plugin is not set up for the profile ${profile}, so ${HOOKS_CONSEQUENCE}`,
        chip: 'hooks not set up',
        commands: [
          {
            label: 'Set up the profile, then restart its sessions',
            code: SETUP_CLAUDE_COMMAND.replace(PROFILE_PLACEHOLDER, profile),
          },
        ],
        guide: true,
      };
    }
    if (hooksCause === 'session_predates') {
      return {
        text: `The agentdock plugin is set up for ${profile}, but this session sent no hook events — it started before the setup. Stop the card and run it again to get live status.`,
        chip: 'restart session',
        commands: [],
        guide: false,
      };
    }
  }
  if (isMirroredCardSource(card.source)) {
    return {
      text: `No hook events from this card's session: the agentdock plugin is not set up for the profile it runs in, so ${HOOKS_CONSEQUENCE}`,
      chip: 'hooks not set up',
      commands: setupCommands(card.profileKey ?? null),
      guide: true,
    };
  }
  if (wiring === 'none') {
    return {
      text: wiringReason
        ? WIRING_REASON_TEXT[wiringReason]
        : `The runner started this round without AgentDock hooks; ${HOOKS_CONSEQUENCE}`,
      chip: 'no hooks',
      commands: [],
      guide: false,
    };
  }
  const via =
    wiring === 'plugin'
      ? "the profile's agentdock plugin"
      : wiring === 'injected'
        ? "the runner's own hook settings"
        : 'AgentDock hooks';
  return {
    text: `The session started with ${via}, but no hook event reached AgentDock within 2 minutes; ${HOOKS_CONSEQUENCE} Check that the runner is online and can reach the API.`,
    chip: 'no hook events',
    commands: [{ label: 'Check the runner', code: RUNNER_STATUS_COMMAND }],
    guide: false,
  };
};

/** #395: the plain sentence for a collect that found no worktree on the runner. */
export const WORKTREE_GONE_TEXT =
  "The card's worktree no longer exists on the runner, so a pull request cannot be created from it.";

/** #395: the runner's `not_found` for a card whose worktree is gone (it names internal ids). */
export const isWorktreeGoneError = (error: string | null): boolean =>
  /not found on the runner.*has no worktree/.test(error ?? '');

/**
 * #395: the line above Create pull request. A vanished worktree gets a plain
 * sentence and no button; every other failure keeps `noPrText`'s wording.
 */
export function noPrBanner(
  card: Pick<BoardCardView, 'collectState' | 'collectError'>,
): { tone: 'warn' | 'info'; text: string; canCreate: boolean } {
  if (
    card.collectState === 'failed' &&
    isWorktreeGoneError(card.collectError)
  ) {
    return {
      tone: 'warn',
      text: `No pull request: ${WORKTREE_GONE_TEXT}`,
      canCreate: false,
    };
  }
  return { ...noPrText(card), canCreate: true };
}

/** The link text after the hint: what the checklist holds. */
export const HOOKS_GUIDE_LABEL = 'See the exact command for each profile';

/** #281 D6: the Settings › Sessions checklist of the card's project. */
export const hooksGuideHref = (projectId: string): string =>
  `/projects/${projectId}/settings?tab=sessions`;

import {
  LOCAL_CARD_BODY_MAX,
  LOCAL_CARD_KINDS,
  LOCAL_CARD_SUMMARY_MAX,
  LOCAL_CARD_TITLE_MAX,
} from '../protocol/local';

/**
 * The project Board (issue #242, ADR-0024): cards Nautelle owns, each worked
 * by a dedicated interactive Claude Code worker outside the orchestrator. The
 * enums mirror the Prisma enums of the same names.
 */

/**
 * D3. `inbox` (#244 D8/D9) holds captured suggestions; it is first, and only
 * operators and above see it.
 */
export const BOARD_COLUMNS = [
  'inbox',
  'todo',
  'in_progress',
  'finished',
  'completed',
] as const;
export type BoardColumn = (typeof BOARD_COLUMNS)[number];

export const isBoardColumn = (value: string): value is BoardColumn =>
  (BOARD_COLUMNS as readonly string[]).includes(value);

/** Decides the branch prefix (`feat` / `fix`) and the issue label. */
export const BOARD_CARD_KINDS = LOCAL_CARD_KINDS;
export type BoardCardKind = (typeof BOARD_CARD_KINDS)[number];

/**
 * Where a card came from (#282 D6):
 * - `manual` — a person on the site;
 * - `captured` — capture (#244), kept after Accept;
 * - `terminal` — `track_card` from a person's own terminal session
 *   (ADR-0030 §1): no worker, it finishes with its session;
 * - `fleet` — the mirror of an orchestrator slot or a `cs:ready` issue
 *   (ADR-0030 §4): its column follows the slot.
 */
export const BOARD_CARD_SOURCES = [
  'manual',
  'captured',
  'terminal',
  'fleet',
] as const;
export type BoardCardSource = (typeof BOARD_CARD_SOURCES)[number];

/**
 * ADR-0030: cards whose work runs outside a card worker — a terminal session
 * or a fleet slot. The Board shows no Run, Stop or feedback for them while
 * that work lives.
 */
export const MIRRORED_CARD_SOURCES = [
  'terminal',
  'fleet',
] as const satisfies readonly BoardCardSource[];
export type MirroredCardSource = (typeof MIRRORED_CARD_SOURCES)[number];

export const isMirroredCardSource = (
  source: BoardCardSource,
): source is MirroredCardSource =>
  (MIRRORED_CARD_SOURCES as readonly BoardCardSource[]).includes(source);

/**
 * D4: what started a round. `ci_fix` (#359 D6) is Nautelle's own round for a
 * red check or a merge conflict on the card's PR; `escalation` (#750 D9) is
 * the relaunch on Opus after the worker's `escalate_card`.
 */
export const CARD_ROUND_TRIGGERS = [
  'run',
  'feedback',
  'ci_fix',
  'escalation',
] as const;
export type CardRoundTrigger = (typeof CARD_ROUND_TRIGGERS)[number];

/**
 * D4/D6: a round's phase. `waiting` is Claude waiting for the person
 * (`hook.stopped`); `background` (#390, ADR-0038) is a turn that stopped with
 * the session's own background tasks still running — the worker waits on
 * them, not on the person; `finished` is done (worker, session end or the
 * person); `ended` is a session that exited without being finished first.
 */
export const CARD_ROUND_PHASES = [
  'queued',
  'starting',
  'running',
  'waiting',
  'background',
  'finished',
  'ended',
  'failed',
  'cancelled',
] as const;
export type CardRoundPhase = (typeof CARD_ROUND_PHASES)[number];

/** D7: a round in one of these phases holds the card in In progress. */
export const ACTIVE_CARD_ROUND_PHASES = [
  'queued',
  'starting',
  'running',
  'waiting',
  'background',
] as const satisfies readonly CardRoundPhase[];
export type ActiveCardRoundPhase = (typeof ACTIVE_CARD_ROUND_PHASES)[number];

export const isActiveRoundPhase = (
  phase: CardRoundPhase | null | undefined,
): phase is ActiveCardRoundPhase =>
  phase != null &&
  (ACTIVE_CARD_ROUND_PHASES as readonly CardRoundPhase[]).includes(phase);

/** D6: who finished a round, in the order the API trusts them. */
export const CARD_FINISHED_BY = ['worker', 'session_end', 'person'] as const;
export type CardFinishedBy = (typeof CARD_FINISHED_BY)[number];

/**
 * #329 D2: how the card's last `card.collect` went, written on every attempt
 * for every source.
 * - `none` — never collected;
 * - `pending` — a collect is running now;
 * - `ok` — a PR was opened, or one is already open (`prUrl` set);
 * - `no_changes` — `ahead: 0`, nothing to push;
 * - `failed` — the runner failed it; `collectError` says why.
 */
export const CARD_COLLECT_STATES = [
  'none',
  'pending',
  'ok',
  'no_changes',
  'failed',
] as const;
export type CardCollectState = (typeof CARD_COLLECT_STATES)[number];

export const isCardCollectState = (value: string): value is CardCollectState =>
  (CARD_COLLECT_STATES as readonly string[]).includes(value);

/** #329 D2: `collectError`, the runner's one line, at most this many characters. */
export const CARD_COLLECT_ERROR_MAX = 500;

/** #329 D4: automatic collect attempts after a failure, counted by `collectAttempts`. */
export const CARD_COLLECT_AUTO_ATTEMPTS_MAX = 3;

/** #329 D4: a failed collect is retried once after this delay. */
export const CARD_COLLECT_RETRY_DELAY_MS = 2 * 60 * 1000;

/**
 * #329 D6: the card's PR as last seen — from the PR poll, else from a
 * `card.collect` / `card.merge` / `card.prClose` result.
 */
export const CARD_PR_STATES = ['open', 'draft', 'merged', 'closed'] as const;
export type CardPrState = (typeof CARD_PR_STATES)[number];

export const isCardPrState = (value: string): value is CardPrState =>
  (CARD_PR_STATES as readonly string[]).includes(value);

/**
 * #359 D5: the checks on the head of the card's PR.
 * - `none` — no PR, or the head has no checks;
 * - `pending` — a check is still running;
 * - `green` — every check passed (or was skipped);
 * - `red` — a check failed or was cancelled; `ciChecks` names them.
 */
export const CARD_CI_STATES = ['none', 'pending', 'green', 'red'] as const;
export type CardCiState = (typeof CARD_CI_STATES)[number];

export const isCardCiState = (value: string): value is CardCiState =>
  (CARD_CI_STATES as readonly string[]).includes(value);

/** #359 D6: `ci_fix` rounds per PR; the next red sets `needsPerson`. */
export const CARD_CI_FIX_ATTEMPTS_MAX = 3;

/** #359 D5: how often the API reads a PR's checks while any is pending. */
export const CARD_CI_POLL_MS = 60_000;

/**
 * #484 (ADR-0043): how long a card PR's head may go without checks, in a
 * project whose CI has reported on a card before, until the API asks the
 * forge to send its event again (`card.ciRetrigger`) — and, after that one
 * retrigger, until the card is marked `needsPerson`.
 */
export const CARD_CI_MISSING_MS = 5 * 60_000;

/**
 * Why a card is marked `needsPerson` — nothing is automated until a person
 * acts: CI still red after the fix budget (#359 D6), CI never reported on
 * the head (#484), or auto-merge refused the head the latest round left
 * (#542) — the round failed, pushed no commit, or ended at once — or
 * `card.collect` found commits on `origin/<branch>` the card's branch never
 * had, so nothing was pushed (#630). A stacked PR that merged into a
 * dependency branch whose own PR had already merged gets a forward PR into
 * the base (#709): `forward_conflict` when that PR conflicts with the base,
 * `forward_failed` when it could not be opened.
 */
export const CARD_NEEDS_PERSON_REASONS = [
  'ci_still_failing',
  'ci_not_reported',
  'round_failed',
  'round_pushed_nothing',
  'round_ended_at_once',
  'branch_diverged',
  'forward_conflict',
  'forward_failed',
] as const;
export type CardNeedsPersonReason = (typeof CARD_NEEDS_PERSON_REASONS)[number];

export const isCardNeedsPersonReason = (
  value: string,
): value is CardNeedsPersonReason =>
  (CARD_NEEDS_PERSON_REASONS as readonly string[]).includes(value);

/**
 * #542: a round that ended this soon after it started did no work — its
 * session died at start. A `feedback` round that does is `failed`, and
 * auto-merge never ships the head such a round leaves.
 */
export const CARD_ROUND_AT_ONCE_MS = 15_000;

/** #359 D1: the runner pushes a card's committed HEAD at most this often. */
export const CARD_PUSH_MIN_INTERVAL_MS = 30_000;

export const BOARD_CARD_TITLE_MAX = LOCAL_CARD_TITLE_MAX;
/** Markdown. */
export const BOARD_CARD_BODY_MAX = LOCAL_CARD_BODY_MAX;
export const CARD_FEEDBACK_MAX = 8_000;
/** The `finish_card` summary (D6), as the `card.finish` local method bounds it. */
export const CARD_SUMMARY_MAX = LOCAL_CARD_SUMMARY_MAX;

/** D13: active rounds per project. */
export const BOARD_MAX_RUNNING_DEFAULT = 3;
export const BOARD_MAX_RUNNING_MIN = 1;
export const BOARD_MAX_RUNNING_MAX = 10;

/**
 * #390: a round in `background` this many minutes raises one
 * `card.background_stalled` — a board setting.
 */
export const CARD_BACKGROUND_STALL_MINUTES_DEFAULT = 30;
export const CARD_BACKGROUND_STALL_MINUTES_MIN = 5;
export const CARD_BACKGROUND_STALL_MINUTES_MAX = 24 * 60;

/** #390: how often the API looks for rounds stalled on their background tasks. */
export const CARD_BACKGROUND_SWEEP_MS = 60_000;

/** #390: the running background command a card shows, at most this long. */
export const CARD_BACKGROUND_COMMAND_MAX = 160;

/** `GET /board` lists the newest Completed cards in pages of this size. */
export const BOARD_COMPLETED_PAGE_SIZE = 50;

/** D6: with no hook event this long after a round starts, the card says "hooks not installed". */
export const CARD_HOOKS_GRACE_MS = 2 * 60 * 1000;

/** D6: how often the runner checks that a card's tmux session is alive. */
export const CARD_SESSION_POLL_MS = 10_000;

/**
 * #624: a dialog still blocking a card's session after this long — one the
 * runner does not answer — makes the round wait for the person.
 */
export const CARD_DIALOG_WAIT_MS = 30_000;

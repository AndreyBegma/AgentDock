import {
  ALWAYS_ALLOWED_LABELS,
  QUEUE_ERROR,
  QUEUE_STATE_LABELS,
  QUEUE_STATES,
  type QueueItemView,
  type QueuePriority,
  type QueueState,
  type QueueView,
  SPEC_GAP_TEXT,
  type SpecGap,
  specGap,
} from '@nautelle/shared';
import { ApiError, describeError } from '../api';
import { updateRunnerText } from '../control/format';
import type { FilterCodec } from '../filters/url-filters';

type Tone = 'ok' | 'warn' | 'danger' | 'neutral';

/** Spec 19 UI: ready ok, in flight neutral, blocked work warn, blocked person danger, no spec muted. */
export const STATE_TONE: Record<QueueState, Tone> = {
  ready: 'ok',
  in_flight: 'neutral',
  blocked_work: 'warn',
  blocked_person: 'danger',
  no_spec: 'neutral',
};

export const stateLabel = (state: QueueState): string =>
  QUEUE_STATE_LABELS[state];

/** The filter chips, in sentence case ("BLOCKED — person" is the board's own spelling). */
export const STATE_CHIP_LABEL: Record<QueueState, string> = {
  in_flight: 'In flight',
  ready: 'Ready',
  blocked_work: 'Blocked by work',
  blocked_person: 'Blocked by a person',
  no_spec: 'No spec',
};

/** The board's five columns, in the order the orchestrator reads them. */
export const BOARD_STATE_ORDER: readonly QueueState[] = [
  'ready',
  'in_flight',
  'blocked_work',
  'blocked_person',
  'no_spec',
];

export const PRIORITY_LABEL: Record<QueuePriority, string> = {
  critical: 'critical',
  high: 'high',
  medium: 'medium',
};

export const priorityLabel = (priority: QueuePriority | null): string =>
  priority === null ? '—' : PRIORITY_LABEL[priority];

/** The state filter as chosen: one state, or `all`. */
export type StateFilter = QueueState | 'all';

export const parseStateFilter = (value: string): StateFilter =>
  QUEUE_STATES.find((s) => s === value) ?? 'all';

export const filterItems = (
  items: readonly QueueItemView[],
  filter: StateFilter,
): QueueItemView[] =>
  filter === 'all' ? [...items] : items.filter((i) => i.state === filter);

/** How many items sit in each state, for the filter chips. */
export function countByState(
  items: readonly QueueItemView[],
): Record<QueueState, number> {
  const counts = Object.fromEntries(QUEUE_STATES.map((s) => [s, 0])) as Record<
    QueueState,
    number
  >;
  for (const item of items) counts[item.state] += 1;
  return counts;
}

export interface BoardCard {
  id: string;
  label: string;
  item: QueueItemView;
}

export interface BoardColumnData {
  id: QueueState;
  title: string;
  cards: BoardCard[];
}

/** D11: one fixed column per state; the API's order (D6) is kept inside each. */
export function boardColumns(
  items: readonly QueueItemView[],
): BoardColumnData[] {
  return BOARD_STATE_ORDER.map((state) => ({
    id: state,
    title: stateLabel(state),
    cards: items
      .filter((item) => item.state === state)
      .map((item) => ({
        id: String(item.number),
        label: `#${item.number} ${item.title}`,
        item,
      })),
  }));
}

/**
 * D4: the muted "Nautelle computes X" note, only when the orchestrator's
 * verdict is shown and Nautelle's own differs.
 */
export function computedNote(item: QueueItemView): string | null {
  if (item.source !== 'orchestrator' || item.computed === null) return null;
  if (item.computed.state === item.state) return null;
  return `Nautelle computes ${stateLabel(item.computed.state)}`;
}

export const sourceLabel = (item: Pick<QueueItemView, 'source'>): string =>
  item.source === 'orchestrator'
    ? 'Verdict from the orchestrator’s latest round'
    : 'Computed by Nautelle from the issues';

/**
 * What fills the queue (rule R3), and how an issue gets in. Before the first
 * snapshot the runner has not looked yet, which is a different reason.
 */
export function queueEmptyDescription(
  readyLabel: string,
  snapshotAt: string | null,
): string {
  const how = `An open issue joins the queue when it carries the “${readyLabel}” label and has an “## Acceptance criteria” section. Add the label on GitHub, or create an issue here.`;
  return snapshotAt
    ? how
    : `The runner has not sent its first snapshot of the issues yet. ${how}`;
}

/** The `Held for a lead` heading, in one sentence. */
export const HELD_FOR_LEAD_HINT =
  'Slots the orchestrator has planned but not dispatched. Each waits on another slot, usually a lead, and goes out when the condition in the last column is met.';

/**
 * Held slots are slots of the orchestrator's plan, not issues of the queue, so
 * they never add up with the chips above; say so next to the count.
 */
export function heldForLeadSummary(count: number): string {
  return `${count} ${count === 1 ? 'slot' : 'slots'} held. These are slots from the orchestrator’s plan, counted apart from the issues above — a held slot may belong to an issue that is already in the queue.`;
}

/** The footer under the list: whose verdict the dots show. */
export const roundFooter = (round: { date: string; round: string }): string =>
  `A green dot marks the orchestrator’s verdict from round ${round.date} ${round.round}. Without one, Nautelle computes the state from the issues.`;

/** The banner for a queue the runner could not read (rule R4): the cause and the fix. */
export function queueUnavailableCopy(
  unavailable: { reason: string },
  runnerName: string | null,
  isAdmin: boolean,
): { title: string; body: string; href?: string; cta?: string } {
  const where = runnerName
    ? `The runner ${runnerName}`
    : 'The project’s runner';
  const machine = runnerName ? `on ${runnerName}` : 'on the runner';
  // The usual cause is the GitHub CLI on the runner's machine, and the fix is
  // there, not on the Runners page (#213).
  if (GH_REASON.test(unavailable.reason)) {
    return {
      title: 'The queue could not be refreshed',
      body: `${where} could not read this project’s issues: ${unavailable.reason}. The list below is the last snapshot. Install the GitHub CLI ${machine} and sign it in with gh auth login, then press Refresh.`,
      href: '/install#troubleshooting',
      cta: `Set up gh ${machine}`,
    };
  }
  return {
    title: 'The queue could not be refreshed',
    body: `${where} could not read this project’s issues: ${unavailable.reason}. The list below is the last snapshot. Fix the cause on that machine, then press Refresh.`,
    ...(isAdmin ? { href: '/admin/runners', cta: 'Open Runners' } : {}),
  };
}

/** A reason that names the GitHub CLI ("gh is not available or timed out"). */
const GH_REASON = /\bgh\b/i;

/** The Queue's filters in the URL (#213): one state chip, and the view. */
export interface QueueFilters {
  state: StateFilter;
  view: 'list' | 'board';
}

export const QUEUE_FILTER_CODEC: FilterCodec<QueueFilters> = {
  keys: ['state', 'view'],
  parse: (params) => ({
    state: parseStateFilter(params.get('state') ?? ''),
    view: params.get('view') === 'board' ? 'board' : 'list',
  }),
  search: ({ state, view }) => {
    const params = new URLSearchParams();
    if (state !== 'all') params.set('state', state);
    if (view === 'board') params.set('view', view);
    const text = params.toString();
    return text ? `?${text}` : '';
  },
};

/** Only `https:` links become anchors; the URL came from a GitHub payload. */
export function safeHttpsUrl(url: string | null): string | null {
  if (url === null) return null;
  try {
    return new URL(url).protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

/**
 * Labels the dialog offers (D7): those seen on the cached issues plus
 * `enhancement`/`bug`, minus the ready label — the toggle owns that one.
 */
export function allowedLabels(view: QueueView | undefined): string[] {
  if (!view) return [...ALWAYS_ALLOWED_LABELS];
  const ready = view.readyLabel.toLowerCase();
  const seen = new Map<string, string>();
  const add = (label: string) => {
    const key = label.toLowerCase();
    if (key !== ready && !seen.has(key)) seen.set(key, label);
  };
  for (const label of ALWAYS_ALLOWED_LABELS) add(label);
  for (const item of view.items) for (const label of item.labels) add(label);
  for (const other of view.others ?? []) {
    for (const label of other.labels) add(label);
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

export interface QueueHint {
  /** Whether "Queue for the orchestrator" can be switched on. */
  canQueue: boolean;
  gap: SpecGap | null;
}

/** The same completeness rule the API applies before it sends anything. */
export function queueHint(body: string, labels: readonly string[]): QueueHint {
  const gap = specGap(body, labels);
  return { canQueue: gap === null, gap };
}

/** The hint under the toggle: what is missing, and what to add. */
export function gapSentence(gap: SpecGap): string {
  const { why, clears } = SPEC_GAP_TEXT[gap];
  const fix = clears.replace(/\s+—\s+\/code-sentinel:spec$/, '');
  return `Cannot be queued: ${why}. Add ${fix}.`.replace(/`([^`]*)`/g, '“$1”');
}

const errorCode = (error: unknown): string | undefined =>
  error instanceof ApiError ? (error.code as string | undefined) : undefined;

/** The labels a `label_not_allowed` body refused; empty when there are none. */
export function refusedLabels(error: unknown): string[] {
  if (!(error instanceof ApiError)) return [];
  const labels = error.body?.labels;
  return Array.isArray(labels)
    ? labels.filter((l): l is string => typeof l === 'string')
    : [];
}

export const isNotFound = (error: unknown): boolean =>
  error instanceof ApiError && error.status === 404;

export const isIssueNotFound = (error: unknown): boolean =>
  errorCode(error) === QUEUE_ERROR.issueNotFound;

/** Every queue error as a sentence for the person; the server's text last. */
export function describeQueueError(
  error: unknown,
  runnerName?: string | null,
): string {
  switch (errorCode(error)) {
    case QUEUE_ERROR.noAcceptanceCriteria:
      return 'The body has no acceptance criteria, so the issue cannot be queued. Add an “## Acceptance criteria” section with at least one “- [ ]” item, or file it without queueing.';
    case QUEUE_ERROR.noParallelPlan:
      return 'The issue is sized XL or larger but has no “## Parallel plan”, so it cannot be queued. Add the plan, or file it without queueing.';
    case QUEUE_ERROR.labelNotAllowed: {
      const labels = refusedLabels(error);
      return labels.length > 0
        ? `These labels are not allowed: ${labels.join(', ')}. Pick labels that exist on the repository.`
        : 'Some of the labels are not allowed. Pick labels that exist on the repository.';
    }
    case QUEUE_ERROR.commandUnavailable:
      return `This runner is too old to create issues, so nothing was sent to GitHub. ${updateRunnerText(runnerName)}`;
    case QUEUE_ERROR.commandFailed:
      return `The runner could not complete the request: ${error instanceof ApiError ? error.message : 'unknown error'}`;
    case QUEUE_ERROR.issueNotFound:
      return 'That issue is no longer in the queue.';
    default:
      break;
  }
  if (error instanceof ApiError && error.status === 404) {
    return 'This project no longer exists, or you are not a member of it.';
  }
  if (error instanceof ApiError && error.status === 403) {
    return 'Only operators can do this.';
  }
  return describeError(error);
}

/** A blocker as `#12 (open)`, plus how it stands when closed. */
export const blockerLabel = (blocker: {
  number: number;
  open: boolean;
}): string =>
  `#${blocker.number} (${blocker.open ? 'open' : 'closed without a merged pull request'})`;

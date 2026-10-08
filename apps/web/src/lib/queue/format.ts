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
} from '@agentdock/shared';
import { ApiError, describeError } from '../api';

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
 * D4: the muted "AgentDock computes X" note, only when the orchestrator's
 * verdict is shown and AgentDock's own differs.
 */
export function computedNote(item: QueueItemView): string | null {
  if (item.source !== 'orchestrator' || item.computed === null) return null;
  if (item.computed.state === item.state) return null;
  return `AgentDock computes ${stateLabel(item.computed.state)}`;
}

export const sourceLabel = (item: Pick<QueueItemView, 'source'>): string =>
  item.source === 'orchestrator'
    ? 'Verdict from the orchestrator’s latest round'
    : 'Computed by AgentDock from the issues';

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
export function describeQueueError(error: unknown): string {
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
      return 'The runner part is not deployed yet, so the issue cannot be sent to GitHub. Nothing was created.';
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

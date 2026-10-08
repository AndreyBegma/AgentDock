import type { NotificationKind } from '@agentdock/shared';
import {
  EVENTS_DUPLICATE_EVENT,
  parseFleetEvent,
  type RunnerEvent,
} from '@agentdock/shared/protocol';

/** The columns of an `events` row the matcher reads. */
export interface MatchableEvent {
  id: bigint;
  runnerId: string;
  seq: bigint;
  ts: Date;
  type: string;
  source: string;
  projectRepo: string | null;
  projectRoot: string | null;
  slot: string | null;
  issue: number | null;
  data: unknown;
}

/**
 * What one event says a person should hear about (spec 22 D1), before
 * recipients, rules and mutes. `title`/`body` are plain text naming the slot
 * or issue and a one-line reason — never pane text, prompts or code (D10).
 */
export interface NotificationDraft {
  kind: Exclude<NotificationKind, 'runner.offline' | 'runner.online'>;
  slot: string | null;
  issue: number | null;
  title: string;
  body: string;
  /** Which project page the link opens. */
  page: 'fleet' | 'overview';
}

/**
 * The plugin's `watch.sh` copies of what the runner observes itself; the
 * runner's own event is the one that notifies (as in `FleetProjector`).
 */
const PLUGIN_ECHOED_TYPES: ReadonlySet<string> = new Set([
  'session.appeared',
  'session.vanished',
  'pane.prompt',
  'pane.idle',
  'pane.quota_hit',
  'pane.busy',
  'worktree.changed',
  'commit.trailer_found',
]);

/** Never notify: bookkeeping rows of spec 16. */
const NEVER: ReadonlySet<string> = new Set([
  EVENTS_DUPLICATE_EVENT,
  'events.unparsed',
]);

/** A single line, at most `max` characters, for a title or body. */
export const oneLine = (value: unknown, max = 200): string | null => {
  if (typeof value !== 'string') return null;
  const line = value.split(/\r?\n/).find((l) => l.trim().length > 0);
  if (!line) return null;
  const trimmed = line.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
};

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const positiveInt = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === 'string' && /^[1-9]\d*$/.test(value)) {
    return Number(value);
  }
  return null;
};

const who = (slot: string | null, issue: number | null): string => {
  if (slot && issue) return `${slot} (#${issue})`;
  if (slot) return slot;
  if (issue) return `#${issue}`;
  return 'The orchestrator';
};

/** The stored row as the shared parsers see it. */
const toRunnerEvent = (event: MatchableEvent): RunnerEvent => ({
  v: 1,
  seq: Number(event.seq),
  ts: event.ts.toISOString(),
  type: event.type,
  source: event.source as RunnerEvent['source'],
  ...(event.projectRoot
    ? {
        project: {
          repo: event.projectRepo ?? '',
          root: event.projectRoot,
        },
      }
    : {}),
  ...(event.slot ? { slot: event.slot } : {}),
  ...(event.issue ? { issue: event.issue } : {}),
  data: event.data,
});

/**
 * The D1 mapping from one stored event to a draft, or null when the event
 * notifies nobody. `queue.dry` is a candidate only: the matcher still checks
 * that no slot runs and that the project had none in the last 6 h.
 */
export const draftFor = (event: MatchableEvent): NotificationDraft | null => {
  if (NEVER.has(event.type)) return null;
  if (event.source === 'code-sentinel' && PLUGIN_ECHOED_TYPES.has(event.type)) {
    return null;
  }
  const data = asRecord(event.data);
  const slot = event.slot ?? (typeof data.slot === 'string' ? data.slot : null);
  const issue = event.issue ?? positiveInt(data.issue);

  switch (event.type) {
    case 'pane.prompt':
    case 'pane.quota_hit': {
      const parsed = parseFleetEvent(toRunnerEvent(event));
      if (!parsed?.ok) return null;
      const target = (parsed.event.data as { target?: string }).target;
      const subject =
        target === 'orchestrator' ? 'The orchestrator' : who(slot, issue);
      if (event.type === 'pane.prompt') {
        const dialog = (parsed.event.data as { dialog?: string }).dialog;
        return {
          kind: 'pane.prompt',
          slot: target === 'orchestrator' ? null : slot,
          issue,
          title: `${subject} is waiting on a launch dialog`,
          body:
            dialog && dialog !== 'other'
              ? `A ${dialog} dialog needs a key press.`
              : 'A dialog needs a key press.',
          page: 'fleet',
        };
      }
      return {
        kind: 'quota.hit',
        slot: target === 'orchestrator' ? null : slot,
        issue,
        title: `${subject} hit its usage limit`,
        body: 'The quota banner is on screen; the session waits until the limit resets.',
        page: 'fleet',
      };
    }
    case 'person.needed': {
      const question = oneLine(data.question);
      return {
        kind: 'person.needed',
        slot,
        issue,
        title: `${who(slot, issue)} needs a person`,
        body: question ?? 'The orchestrator is waiting for a decision.',
        page: 'fleet',
      };
    }
    case 'slot.checkpoint': {
      const parsed = parseFleetEvent(toRunnerEvent(event));
      if (!parsed?.ok || parsed.event.type !== 'slot.checkpoint') return null;
      if (parsed.event.data.checkpoint !== 'blocked') return null;
      return {
        kind: 'slot.blocked',
        slot,
        issue,
        title: `${who(slot, issue)} is blocked`,
        body: 'The worker reported a blocked checkpoint.',
        page: 'fleet',
      };
    }
    case 'issue.blocked': {
      if (data.kind !== 'person') return null;
      return {
        kind: 'slot.blocked',
        slot,
        issue,
        title: `${who(slot, issue)} is blocked on a person`,
        body:
          oneLine(data.why) ?? 'The orchestrator needs a person to unblock it.',
        page: 'fleet',
      };
    }
    case 'pr.awaiting_approval': {
      const pr = positiveInt(data.pr);
      return {
        kind: 'pr.awaiting_approval',
        slot,
        issue,
        title: pr
          ? `PR #${pr} is waiting for approval`
          : `${who(slot, issue)} has a PR waiting for approval`,
        body: 'The orchestrator will merge it once a person approves.',
        page: 'fleet',
      };
    }
    case 'round.decided': {
      const parsed = parseFleetEvent(toRunnerEvent(event));
      if (!parsed?.ok || parsed.event.type !== 'round.decided') return null;
      const { dispatching, inFlight } = parsed.event.data.decisions;
      if (dispatching.length > 0 || inFlight.length > 0) return null;
      return {
        kind: 'queue.dry',
        slot: null,
        issue: null,
        title: 'The queue is dry',
        body: 'The last round found nothing ready and nothing in flight.',
        page: 'overview',
      };
    }
    default:
      return null;
  }
};

/** The web path a project notification opens. */
export const projectLink = (
  projectId: string,
  page: NotificationDraft['page'],
): string =>
  page === 'fleet' ? `/projects/${projectId}/fleet` : `/projects/${projectId}`;

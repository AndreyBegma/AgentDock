import {
  CARD_FINISHED_EVENT,
  CARD_WAITING_EVENT,
  CARDS_SUGGESTED_EVENT,
  cardLabel,
  type NotificationKind,
  SCHEDULE_DISABLED_LIVE_EVENT,
} from '@agentdock/shared';
import {
  API_EVENT_SOURCE,
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
  page: 'fleet' | 'overview' | 'schedules' | 'board';
  /** `board`: the card the link opens (`?card=<number>`). */
  card?: number;
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

/**
 * Who a notification is about. A slot named by a bare number ("719") is the
 * issue's number, not a name, and a title with no slot still names the issue,
 * so neither reads as "719 is blocked".
 */
const who = (slot: string | null, issue: number | null): string => {
  const named = slot && !/^\d+$/.test(slot) ? slot : null;
  const number = issue ?? (slot && !named ? Number(slot) : null);
  if (named && number) return `${named} (#${number})`;
  if (named) return named;
  if (number) return `Issue #${number}`;
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
    // A blocked checkpoint notifies from the sweep, once per checkpoint and
    // only when it still stands after the delay (spec 22 note 23), never here.
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
    case SCHEDULE_DISABLED_LIVE_EVENT: {
      // Only the API records this (spec 25 D17); a runner must not forge it.
      if (event.source !== API_EVENT_SOURCE) return null;
      const name = oneLine(data.scheduleName, 80);
      const reason = data.disabledReason;
      return {
        kind: 'schedule.disabled',
        slot: null,
        issue: null,
        title: name
          ? `Schedule "${name}" was disabled`
          : 'A schedule was disabled',
        body:
          reason === 'failing'
            ? 'It failed repeatedly, so it will not fire again until it is re-enabled.'
            : reason === 'creator_not_authorized'
              ? 'Its creator is no longer allowed to run it; it stays off until it is re-enabled.'
              : 'It stays off until it is re-enabled.',
        page: 'schedules',
      };
    }
    // Issue #242 D15: only the API records these; they name the card and its
    // PR, never prompt or summary text.
    case CARD_FINISHED_EVENT:
    case CARD_WAITING_EVENT: {
      if (event.source !== API_EVENT_SOURCE) return null;
      const number = positiveInt(data.number);
      if (!number) return null;
      const title = oneLine(data.title, 120);
      const card = title
        ? `${cardLabel(number)} "${title}"`
        : `Card ${cardLabel(number)}`;
      if (event.type === CARD_WAITING_EVENT) {
        return {
          kind: 'card.waiting',
          slot: null,
          issue: null,
          title: `${card} is waiting for you`,
          body: 'Its worker stopped and waits for a reply in its session.',
          page: 'board',
          card: number,
        };
      }
      const pr = positiveInt(data.prNumber);
      return {
        kind: 'card.finished',
        slot: null,
        issue: null,
        title: `${card} is finished`,
        body: pr
          ? `PR #${pr} is ready for review.`
          : 'Review it on the board: accept it, or send feedback.',
        page: 'board',
        card: number,
      };
    }
    // Issue #244 D11: only the API records it; counts only — a suggestion's
    // title is content-derived, so it is never quoted.
    case CARDS_SUGGESTED_EVENT: {
      if (event.source !== API_EVENT_SOURCE) return null;
      const count = positiveInt(data.count);
      if (!count) return null;
      return {
        kind: 'cards.suggested',
        slot: null,
        issue: null,
        title:
          count === 1
            ? 'A card was suggested'
            : `${count} cards were suggested`,
        body: 'Capture found follow-up work in a session; review it in the Inbox.',
        page: 'board',
      };
    }
    default:
      return null;
  }
};

/** A heading that says nothing beyond its kind: "blocked", "Blocked:". */
const BARE_BLOCKED = /^blocked\W*$/i;

/**
 * The `slot.blocked` draft of a scraped or plugin checkpoint that is still
 * standing (spec 22 note 23). The heading is the reason; the summary is never
 * copied (D10).
 */
export const blockedCheckpointDraft = (
  slot: string,
  issue: number | null,
  heading: string,
): NotificationDraft => {
  const line = oneLine(heading);
  return {
    kind: 'slot.blocked',
    slot,
    issue,
    title: `${who(slot, issue)} is blocked`,
    body:
      line && !BARE_BLOCKED.test(line)
        ? line
        : 'The worker reported a blocked checkpoint.',
    page: 'fleet',
  };
};

/** The web path a project notification opens. */
export const projectLink = (
  projectId: string,
  page: NotificationDraft['page'],
  card?: number,
): string => {
  if (page === 'board') {
    return `/projects/${projectId}/board${card ? `?card=${card}` : ''}`;
  }
  if (page === 'fleet') return `/projects/${projectId}/fleet`;
  if (page === 'schedules') return `/projects/${projectId}/schedules`;
  return `/projects/${projectId}`;
};

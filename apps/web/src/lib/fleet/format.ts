import {
  FLEET_ERROR,
  type FleetChannel,
  type OrchestratorStatus,
  type SlotStatus,
} from '@agentdock/shared';
import type { CheckpointKind, PrChecks } from '@agentdock/shared/protocol';
import type { RailBadge } from '@andrewbehma/glass-ui/nav-rail';
import { ApiError, describeError, type ErrorHint } from '../api';

type Tone = 'ok' | 'warn' | 'danger' | 'neutral';

export const SLOT_STATUS_TONE: Record<SlotStatus, Tone> = {
  dispatched: 'neutral',
  running: 'ok',
  idle: 'neutral',
  prompt: 'warn',
  quota: 'danger',
  stale: 'danger',
  ended: 'neutral',
};

export const SLOT_STATUS_LABEL: Record<SlotStatus, string> = {
  dispatched: 'dispatched',
  running: 'running',
  idle: 'idle',
  prompt: 'waiting on a prompt',
  quota: 'quota hit',
  stale: 'stale',
  ended: 'ended',
};

/**
 * A slot that waits on a person: stuck on a launch prompt, out of quota, or
 * dead with its PR unmerged. The rail counts these on Fleet (#163).
 */
const ATTENTION: ReadonlySet<SlotStatus> = new Set([
  'prompt',
  'quota',
  'stale',
]);

export const needsAttention = (slot: { status: SlotStatus }): boolean =>
  ATTENTION.has(slot.status);

/** The rail's mark on Fleet while slots need someone; nothing at zero. */
export const attentionBadge = (count: number): RailBadge | undefined =>
  count > 0
    ? {
        count,
        tone: 'warn',
        label:
          count === 1
            ? '1 slot needs attention'
            : `${count} slots need attention`,
      }
    : undefined;

export const ORCHESTRATOR_TONE: Record<OrchestratorStatus, Tone> = {
  running: 'ok',
  idle: 'neutral',
  absent: 'warn',
  unknown: 'neutral',
};

export const CHANNEL_TONE: Record<FleetChannel, Tone> = {
  events: 'ok',
  scraped: 'neutral',
  both: 'warn',
};

export const CHANNEL_TOOLTIP: Record<FleetChannel, string> = {
  events:
    'Facts come from the Code Sentinel plugin’s events.jsonl; a plugin event arrived in the last 24 hours.',
  scraped:
    'No plugin events in the last 24 hours — facts are scraped from the orchestrator’s markdown boards, briefs and reply files.',
  both: 'The plugin is sending events, but some fields it covers were last written by scraping markdown.',
};

export function channelChip(channel: FleetChannel): {
  label: string;
  tone: Tone;
  tooltip: string;
} {
  return {
    label: CHANNEL_LABEL[channel],
    tone: CHANNEL_TONE[channel],
    tooltip: CHANNEL_TOOLTIP[channel],
  };
}

export const CHECKS_TONE: Record<PrChecks, Tone> = {
  pending: 'warn',
  green: 'ok',
  red: 'danger',
};

export const CHECKS_LABEL: Record<PrChecks, string> = {
  pending: 'checks pending',
  green: 'checks green',
  red: 'checks failing',
};

export const CHECKPOINT_LABEL: Record<CheckpointKind, string> = {
  picked_up: 'picked up',
  plan_ready: 'plan ready',
  implementation_done: 'implementation done',
  pr_open: 'pull request open',
  blocked: 'blocked',
  misclassified: 'misclassified',
  other: 'other',
};

/** A blocked or misclassified slot needs a person; the rest is progress. */
export const CHECKPOINT_TONE: Record<CheckpointKind, Tone> = {
  picked_up: 'neutral',
  plan_ready: 'neutral',
  implementation_done: 'ok',
  pr_open: 'ok',
  blocked: 'danger',
  misclassified: 'warn',
  other: 'neutral',
};

export const checkpointLabel = (kind: CheckpointKind | null): string =>
  kind === null ? '—' : CHECKPOINT_LABEL[kind];

/** `3 min`, `2 h`, `4 d` since `iso`; `just now` under five seconds. */
export function formatAge(iso: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.round(hours / 24)} d`;
}

/** `formatAge` as a sentence tail: `3 min ago`, but never `just now ago`. */
export function formatAgo(iso: string, now = Date.now()): string {
  const age = formatAge(iso, now);
  return age === 'just now' ? age : `${age} ago`;
}

/** `↑2 ↓1` against the base; `—` when the runner has not measured it. */
export function formatAheadBehind(
  ahead: number | null,
  behind: number | null,
): string {
  if (ahead === null && behind === null) return '—';
  return `↑${ahead ?? 0} ↓${behind ?? 0}`;
}

/** `occupied / max`, or `—` before any round was seen. */
export function formatOccupancy(
  round: { occupied: number; max: number } | null,
): string {
  return round ? `${round.occupied} / ${round.max}` : '—';
}

/** `YYYY-MM-DD/HHMM` → `YYYY-MM-DD HH:MM`; anything else is shown as given. */
export function formatRound(round: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})\/(\d{2})(\d{2})$/.exec(round);
  return match ? `${match[1]} ${match[2]}:${match[3]}` : round;
}

/** A round header's date and `HHMM` label as a local-time-free string. */
export function formatRoundHeader(date: string, label: string): string {
  return formatRound(`${date}/${label}`);
}

/**
 * The GitHub issue URL for `issue`, derived from a pull request URL of the same
 * repository (`https://github.com/o/r/pull/7` → `…/o/r/issues/N`). The project
 * has no repository URL yet, so a slot without a PR has no link.
 */
export function issueUrl(
  issue: number | null,
  prUrl: string | null,
): string | null {
  if (issue === null || prUrl === null) return null;
  const match = /^(https:\/\/[^/]+\/[^/]+\/[^/]+)\/pull\/\d+/.exec(prUrl);
  return match ? `${match[1]}/issues/${issue}` : null;
}

/** Only `https:` links are rendered as anchors; the URL came from a markdown file. */
export function safeHttpsUrl(url: string | null): string | null {
  if (url === null) return null;
  try {
    return new URL(url).protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

export interface SlotQuery {
  status?: SlotStatus;
  issue?: number;
  cursor?: string;
  limit?: number;
}

export function slotsQuery(query: SlotQuery): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== '') params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : '';
}

/** The issue filter as typed: a positive whole number, else not set. */
export function parseIssueFilter(text: string): number | undefined {
  const trimmed = text.trim().replace(/^#/, '');
  if (!/^\d+$/.test(trimmed)) return undefined;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

export const isNotFound = (error: unknown): boolean =>
  error instanceof ApiError && error.status === 404;

export const isSlotNotFound = (error: unknown): boolean =>
  error instanceof ApiError &&
  (error.code as string | undefined) === FLEET_ERROR.slotNotFound;

export function describeFleetErrorHint(error: unknown): ErrorHint {
  if (isSlotNotFound(error)) return { text: 'That slot no longer exists.' };
  if (error instanceof ApiError && error.status === 404) {
    return {
      text: 'This project no longer exists, or you are not a member of it.',
      href: '/projects',
      cta: 'Open Projects',
    };
  }
  if (error instanceof ApiError && error.status === 400) {
    return { text: `Invalid filter: ${error.message}` };
  }
  return { text: describeError(error) };
}

export const describeFleetError = (error: unknown): string =>
  describeFleetErrorHint(error).text;

/** The orchestrator's state as the card says it: what it means, not the enum. */
export const ORCHESTRATOR_STATUS_LABEL: Record<OrchestratorStatus, string> = {
  running: 'Running',
  idle: 'Idle',
  absent: 'Not running',
  unknown: 'Status unknown',
};

export const ORCHESTRATOR_STATUS_HINT: Record<OrchestratorStatus, string> = {
  running: 'The orchestrator session is alive and working on a round.',
  idle: 'The orchestrator session is alive but waiting for input.',
  absent:
    'No orchestrator session was found on the project’s machine. Start it to dispatch work.',
  unknown:
    'AgentDock has not heard from the project’s machine yet, so it cannot say.',
};

/** One-line hints for the orchestrator card’s facts. */
export const FLEET_FACT_HINT = {
  base: 'The branch pull requests are opened against.',
  slots: 'Slots in use out of the most the orchestrator runs at once.',
  lastRound:
    'A round is one pass of the orchestrator: it reads the queue and dispatches workers.',
  session:
    'The tmux session the orchestrator runs in on the project’s machine.',
} as const;

/** The channel badge’s name, for people who have not read the plugin docs. */
export const CHANNEL_LABEL: Record<FleetChannel, string> = {
  events: 'events',
  scraped: 'scraped',
  both: 'events + scraped',
};

/** One line under each slot-sheet term. */
export const SLOT_TERM_HINT = {
  brief: 'The task the orchestrator gave this worker.',
  owns: 'Files and folders this worker may change.',
  never: 'Files and folders this worker must not open.',
  lead: 'A lead slot also owns shared files, such as the schema, that others wait on.',
} as const;

/** What to do about a board that could not be read. */
export function boardErrorHint(error: {
  reason: string;
  file: string;
  line?: number | null;
}): string {
  const where = `${error.file}${error.line ? `:${error.line}` : ''}`;
  return `The latest board could not be read: ${error.reason} (${where}). Fix that file in the project, then the next round picks it up.`;
}

/**
 * Stop makes sense only while there is a session to stop; `absent` is known to
 * be not running, so the button is not drawn. `unknown` keeps it — nothing was
 * observed yet, and the control reasons say what is missing.
 */
export const showStopControl = (status: OrchestratorStatus): boolean =>
  status !== 'absent';

/** A board error split for a banner: a short title, the detail and the file to fix. */
export function boardErrorView(error: {
  reason: string;
  file: string;
  line?: number | null;
}): { title: string; detail: string; path: string } {
  const path = `${error.file}${error.line ? `:${error.line}` : ''}`;
  return {
    title: 'The orchestrator’s board could not be read',
    detail: `${error.reason} (${path}). Fix that file in the project, then the next round picks it up.`,
    path,
  };
}

/** What "scraped" means, in a sentence, for whoever sees the chip. */
export const CHANNEL_EXPLANATION: Record<FleetChannel, string | null> = {
  events: null,
  scraped:
    'Scraped: AgentDock is reading the orchestrator’s markdown files because the Code Sentinel plugin sent no events in the last 24 hours. The facts are right but can lag a minute or two.',
  both: 'Mixed: some facts come from plugin events, the rest from scraping the orchestrator’s markdown files.',
};

/** The slot-status filter: every status by its label, in the order they happen. */
export const slotStatusOptions = (): { value: SlotStatus; label: string }[] =>
  (Object.keys(SLOT_STATUS_LABEL) as SlotStatus[]).map((value) => ({
    value,
    label: SLOT_STATUS_LABEL[value],
  }));

/** The empty fleet in one sentence (rule R3); "no matches" is a separate message. */
export const EMPTY_FLEET_DESCRIPTION =
  'A slot is one worker on one issue. The orchestrator fills slots each round, so they appear here once it dispatches work on this project.';

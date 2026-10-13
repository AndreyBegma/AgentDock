import type {
  ActivityItem,
  ApprovalsView,
  FleetView,
  OrchestratorStatus,
  ProjectSummary,
  SlotStatus,
  SlotSummary,
  UsageTimeseriesResponse,
} from '@agentdock/shared';

/**
 * The Overview dashboard (issue #159) is composed from the per-project routes
 * the app already has — there is no aggregate endpoint. These helpers turn
 * those answers into the figures and lists the page shows, so the page only
 * fetches and renders.
 */

/** A slot whose session is alive: it is working, waiting, or out of quota. */
const ALIVE: ReadonlySet<SlotStatus> = new Set([
  'running',
  'idle',
  'prompt',
  'quota',
]);

export const isAlive = (slot: Pick<SlotSummary, 'status'>): boolean =>
  ALIVE.has(slot.status);

/** Local midnight today, as an instant: "today" is the viewer's day. */
export function startOfToday(now: Date = new Date()): string {
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  return day.toISOString();
}

/** The start of the hour after `now` — the usage range's exclusive end. */
export function nextHour(now: Date = new Date()): string {
  const hour = new Date(now);
  hour.setMinutes(0, 0, 0);
  hour.setHours(hour.getHours() + 1);
  return hour.toISOString();
}

/** The six local midnights before today, and today: a 7-day range. */
export function lastSevenDays(now: Date = new Date()): {
  from: string;
  to: string;
} {
  const from = new Date(now);
  from.setHours(0, 0, 0, 0);
  from.setDate(from.getDate() - 6);
  return { from: from.toISOString(), to: nextHour(now) };
}

export function runningSlots(fleets: Iterable<FleetView>): number {
  let count = 0;
  for (const fleet of fleets) {
    for (const slot of fleet.slots) if (isAlive(slot)) count += 1;
  }
  return count;
}

/**
 * `ApprovalsView.waiting` holds a PR's *current* row, which is `approved` once
 * somebody decided and the merge has not happened; only `waiting` asks a person.
 */
const awaiting = (view: ApprovalsView) =>
  view.waiting.filter((row) => row.status === 'waiting');

export function waitingApprovals(views: Iterable<ApprovalsView>): number {
  let count = 0;
  for (const view of views) count += awaiting(view).length;
  return count;
}

/**
 * Pull requests merged today. An event can reach the feed twice (the plugin
 * and the scraper both see a merge), so a PR counts once per project.
 */
export function mergedPullRequests(items: ActivityItem[]): number {
  const seen = new Set<string>();
  for (const item of items) {
    if (item.type !== 'pr.merged') continue;
    seen.add(`${item.projectId ?? ''}#${item.prNumber ?? item.id}`);
  }
  return seen.size;
}

export type NeedsYouItem = {
  /** Unique across the list. */
  key: string;
  kind: 'blocked' | 'prompt' | 'approval';
  projectId: string;
  projectName: string;
  /** "Slot i42 · #42", "PR #57 · fix the login" */
  title: string;
  /** What the person is asked to do. */
  reason: string;
  href: string;
  /** When it started waiting: the slot's last update, the approval's wait. */
  since: string;
};

/**
 * What waits on a person, oldest first: slots whose last checkpoint is
 * `blocked`, slots whose pane sits on a permission or launch prompt, and pull
 * requests waiting for a merge approval.
 */
export function needsYou(
  projects: ProjectSummary[],
  fleets: ReadonlyMap<string, FleetView>,
  approvals: ReadonlyMap<string, ApprovalsView>,
): NeedsYouItem[] {
  const items: NeedsYouItem[] = [];
  for (const project of projects) {
    const base = { projectId: project.id, projectName: project.displayName };
    for (const slot of fleets.get(project.id)?.slots ?? []) {
      if (slot.status === 'ended') continue;
      const title = slotTitle(slot);
      if (slot.lastCheckpoint === 'blocked') {
        items.push({
          ...base,
          key: `blocked:${slot.id}`,
          kind: 'blocked',
          title,
          reason: 'Blocked — waiting for a decision',
          href: `/projects/${project.id}/fleet`,
          since: slot.updatedAt,
        });
      } else if (slot.status === 'prompt') {
        items.push({
          ...base,
          key: `prompt:${slot.id}`,
          kind: 'prompt',
          title,
          reason: 'Waiting on a prompt in its session',
          href: `/projects/${project.id}/fleet`,
          since: slot.updatedAt,
        });
      }
    }
    const view = approvals.get(project.id);
    for (const approval of view ? awaiting(view) : []) {
      items.push({
        ...base,
        key: `approval:${approval.id}`,
        kind: 'approval',
        title: approval.title
          ? `PR #${approval.pr} · ${approval.title}`
          : `PR #${approval.pr}`,
        reason: 'Waiting for your merge approval',
        href: `/projects/${project.id}/approvals`,
        since: approval.waitingSince,
      });
    }
  }
  return items.sort((a, b) => Date.parse(a.since) - Date.parse(b.since));
}

/** "Slot i42 · #42" — the slot's name and, when it has one, its issue. */
export function slotTitle(slot: Pick<SlotSummary, 'name' | 'issue'>): string {
  return slot.issue === null
    ? `Slot ${slot.name}`
    : `Slot ${slot.name} · #${slot.issue}`;
}

/** Daily cost per project, keyed by project id, from a `groupBy=project` series. */
export function costByProject(
  response: Pick<UsageTimeseriesResponse, 'series'>,
): Map<string, number[]> {
  const byProject = new Map<string, number[]>();
  for (const series of response.series) {
    if (!series.key) continue;
    byProject.set(
      series.key,
      series.points.map((p) => {
        const cost = Number(p.costUsd);
        return Number.isFinite(cost) ? cost : 0;
      }),
    );
  }
  return byProject;
}

export const ORCHESTRATOR_LABEL: Record<OrchestratorStatus, string> = {
  running: 'Orchestrator running',
  idle: 'Orchestrator idle',
  absent: 'Orchestrator stopped',
  unknown: 'Orchestrator not seen yet',
};

export const ORCHESTRATOR_TONE: Record<
  OrchestratorStatus,
  'ok' | 'neutral' | 'warn'
> = {
  running: 'ok',
  idle: 'neutral',
  absent: 'neutral',
  unknown: 'neutral',
};

/** "Round Oct 13, 14:05 · 3 of 5 slots" — a round's start and occupancy. */
export function roundLabel(
  round: FleetView['latestRound'],
  formatDay: (iso: string) => string,
): string | null {
  if (!round) return null;
  const hhmm = /^\d{4}$/.test(round.label)
    ? `${round.label.slice(0, 2)}:${round.label.slice(2)}`
    : round.label;
  const day = formatDay(`${round.date}T00:00:00`);
  return `Round ${day}, ${hhmm} · ${round.occupied} of ${round.max} slots`;
}

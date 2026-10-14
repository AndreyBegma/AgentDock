import type {
  ActivityItem,
  ApprovalsView,
  FleetView,
  OrchestratorStatus,
  ProjectSummary,
  RunSummary,
  SlotStatus,
  SlotSummary,
  UsageTimeseriesResponse,
} from '@agentdock/shared';
import { orchestratorSettingsHref } from '../control/reasons';
import { ORCHESTRATOR_STATUS_LABEL } from '../fleet/format';
import { slotHref } from '../fleet/workspace-url';

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
 * Where each Overview figure is explained (#213). Running slots go to
 * Sessions: Fleet is per project, and Sessions lists every live one.
 */
export const OVERVIEW_TILE_HREF = {
  running: '/sessions',
  cost: '/usage?range=today',
  merged: '/activity',
} as const;

/**
 * Approvals has no cross-project page: the tile opens the first project, in
 * the list's order, with a pull request waiting — else Projects.
 */
export function approvalsHref(
  projects: readonly Pick<ProjectSummary, 'id'>[],
  approvals: ReadonlyMap<string, ApprovalsView>,
): string {
  const first = projects.find((project) => {
    const view = approvals.get(project.id);
    return view !== undefined && awaiting(view).length > 0;
  });
  return first ? `/projects/${first.id}/approvals` : '/projects';
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
  kind: 'profile' | 'failed' | 'blocked' | 'prompt' | 'approval';
  projectId: string;
  projectName: string;
  /** "Slot i42 · #42", "PR #57 · fix the login" */
  title: string;
  /** What the person is asked to do. */
  reason: string;
  href: string;
  /**
   * When it started waiting: the slot's last update, the approval's wait, the
   * run's end. Null for a missing profile, which has no moment — it is
   * listed first, since nothing on that project can start until it is set.
   */
  since: string | null;
};

/** How far back a failed run still asks for a look. */
export const FAILED_RUN_WINDOW_MS = 24 * 60 * 60 * 1000;

/** What `needsYou` knows beyond the fleets and approvals. */
export interface NeedsYouExtra {
  /** Each project's failed runs, as `/runs?status=failed` answered. */
  failedRuns?: ReadonlyMap<string, readonly RunSummary[]>;
  /** Projects with neither an orchestrator profile nor a default one. */
  missingProfile?: ReadonlySet<string>;
  now?: number;
}

/** "Slot i4 · #4", else the run's title, else its kind. */
function runTitle(run: RunSummary): string {
  if (run.slot !== null) return slotTitle({ name: run.slot, issue: run.issue });
  return run.title ?? 'A run';
}

/**
 * What waits on a person: projects that cannot start an orchestrator for want
 * of a runtime profile, then, oldest first, runs that failed in the last 24
 * hours, slots whose last checkpoint is `blocked`, slots whose pane sits on a
 * permission or launch prompt, and pull requests waiting for a merge approval.
 */
export function needsYou(
  projects: ProjectSummary[],
  fleets: ReadonlyMap<string, FleetView>,
  approvals: ReadonlyMap<string, ApprovalsView>,
  { failedRuns, missingProfile, now = Date.now() }: NeedsYouExtra = {},
): NeedsYouItem[] {
  const items: NeedsYouItem[] = [];
  for (const project of projects) {
    const base = { projectId: project.id, projectName: project.displayName };
    if (missingProfile?.has(project.id)) {
      items.push({
        ...base,
        key: `profile:${project.id}`,
        kind: 'profile',
        title: 'No default runtime profile',
        reason: 'Choose one so the orchestrator can start',
        href: orchestratorSettingsHref(project.id),
        since: null,
      });
    }
    for (const run of failedRuns?.get(project.id) ?? []) {
      if (run.status !== 'failed') continue;
      const ended = run.endedAt ?? run.updatedAt;
      if (now - Date.parse(ended) > FAILED_RUN_WINDOW_MS) continue;
      items.push({
        ...base,
        key: `failed:${run.id}`,
        kind: 'failed',
        title: runTitle(run),
        reason: 'Failed — see what went wrong',
        href: `/projects/${project.id}/history/${run.id}`,
        since: ended,
      });
    }
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
          href: slotHref(project.id, slot.name),
          since: slot.updatedAt,
        });
      } else if (slot.status === 'prompt') {
        items.push({
          ...base,
          key: `prompt:${slot.id}`,
          kind: 'prompt',
          title,
          reason: 'Waiting on a prompt in its session',
          href: slotHref(project.id, slot.name),
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
  // A stable sort: missing profiles first, in project order; the rest by age.
  const at = (item: NeedsYouItem) =>
    item.since === null ? Number.NEGATIVE_INFINITY : Date.parse(item.since);
  return items.sort((a, b) => at(a) - at(b));
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

/** "Orchestrator: Not running" — the Fleet's one vocabulary, named (#213). */
export const orchestratorLabel = (status: OrchestratorStatus): string =>
  `Orchestrator: ${ORCHESTRATOR_STATUS_LABEL[status]}`;

/**
 * "Round Oct 13, 14:05 · up to 5 slots" — a round's start and ceiling. Not
 * the board's `occupied`: a board that stopped parsing keeps its last figure,
 * and the card beside it counts the live slots (#213).
 */
export function roundLabel(
  round: FleetView['latestRound'],
  formatDay: (iso: string) => string,
): string | null {
  if (!round) return null;
  const hhmm = /^\d{4}$/.test(round.label)
    ? `${round.label.slice(0, 2)}:${round.label.slice(2)}`
    : round.label;
  const day = formatDay(`${round.date}T00:00:00`);
  return `Round ${day}, ${hhmm} · up to ${round.max} slots`;
}

import type {
  ApprovalsView,
  FleetView,
  RunKind,
  RunSummary,
} from '@nautelle/shared';
import { slotHref } from '../fleet/workspace-url';
import { runHref } from '../history/format';

/**
 * What the calm project home (C-283) says: pure, so the rules are tested
 * without a page. Everything is computed from what the API already serves —
 * the fleet, the approvals and the project's latest runs.
 */

/** The runs that are bookkeeping, not work: never a "task" on this page. */
const HOUSEKEEPING: ReadonlySet<RunKind> = new Set([
  'card_capture',
  'text_normalize',
]);

export const isTask = (run: Pick<RunSummary, 'kind'>): boolean =>
  !HOUSEKEEPING.has(run.kind);

/** The latest task that ended with a result: it succeeded or it failed. */
export function recentResult(
  runs: readonly RunSummary[],
): RunSummary | undefined {
  return runs.find(
    (run) =>
      isTask(run) && (run.status === 'succeeded' || run.status === 'failed'),
  );
}

export interface NeedsYouItem {
  id: string;
  kind: 'approval' | 'prompt' | 'checks' | 'run';
  title: string;
  /** Slot, PR and issue, as one line. */
  detail: string;
  href: string;
  /** When it started waiting, when known. */
  since?: string;
}

/**
 * What waits for a person: pull requests to approve, slots stopped on a
 * dialog, open pull requests whose checks fail, runs that ask for a person.
 * The kinds keep this order.
 */
export function needsYou(
  projectId: string,
  approvals: ApprovalsView | undefined,
  fleet: FleetView | undefined,
  runs: readonly RunSummary[],
): NeedsYouItem[] {
  const items: NeedsYouItem[] = [];
  for (const row of approvals?.waiting ?? []) {
    items.push({
      id: `approval:${row.id}`,
      kind: 'approval',
      title: row.title ?? `Pull request #${row.pr}`,
      detail: [`#${row.pr}`, row.slot].filter(Boolean).join(' · '),
      href: `/projects/${projectId}/approvals`,
      since: row.waitingSince,
    });
  }
  for (const slot of fleet?.slots ?? []) {
    const issue = slot.issue === null ? null : `#${slot.issue}`;
    if (slot.status === 'prompt') {
      items.push({
        id: `prompt:${slot.id}`,
        kind: 'prompt',
        title: `${slot.name} is waiting on a dialog`,
        detail: [issue, slot.branch].filter(Boolean).join(' · '),
        href: slotHref(projectId, slot.name),
        since: slot.updatedAt,
      });
    } else if (slot.status !== 'ended' && slot.prChecks === 'red') {
      items.push({
        id: `checks:${slot.id}`,
        kind: 'checks',
        title: `Checks failed on ${slot.prNumber === null ? slot.name : `#${slot.prNumber}`}`,
        detail: [slot.name, issue].filter(Boolean).join(' · '),
        href: slotHref(projectId, slot.name),
        since: slot.updatedAt,
      });
    }
  }
  for (const run of runs) {
    if (run.status !== 'waiting_person' || !isTask(run)) continue;
    items.push({
      id: `run:${run.id}`,
      kind: 'run',
      title: run.title?.trim() || 'A run asks for a person',
      detail: [run.slot, run.issue === null ? null : `#${run.issue}`]
        .filter(Boolean)
        .join(' · '),
      href: runHref(projectId, run.id),
      since: run.updatedAt,
    });
  }
  return items;
}

/**
 * The header's sentence: how many slots work and how many things wait. Empty
 * until the fleet has loaded.
 */
export function summarySentence(
  fleet: FleetView | undefined,
  waiting: number,
): string | undefined {
  if (!fleet) return undefined;
  const live = fleet.slots.filter((slot) => slot.status !== 'ended');
  const working = live.filter((slot) => slot.status === 'running').length;
  const seats = Math.max(fleet.latestRound?.max ?? 0, live.length);
  const slots =
    seats === 0
      ? 'No slots are working.'
      : `${working} of ${seats} ${seats === 1 ? 'slot is' : 'slots are'} working.`;
  const needs =
    waiting === 0
      ? 'Nothing needs you.'
      : `${waiting} ${waiting === 1 ? 'thing needs' : 'things need'} you.`;
  return `${slots} ${needs}`;
}

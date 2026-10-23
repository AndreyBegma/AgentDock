import type { TerminalSetupNeed } from '../setup/format';
import type { NeedsYouItem } from './dashboard';

/** What a Needs-you row is about: a slot or run kind, or a setup need. */
export type NeedsRowKind = NeedsYouItem['kind'] | 'terminal-setup';

/** One project's link inside a row. */
export interface NeedsRowMember {
  key: string;
  projectId: string;
  projectName: string;
  reason: string;
  href: string;
  since: string | null;
}

/** A row of the Needs-you block: one problem, in one or more projects. */
export interface NeedsRow {
  /** Unique across the list. */
  key: string;
  kind: NeedsRowKind;
  title: string;
  /** Never empty; more than one means the row is grouped and expandable. */
  members: NeedsRowMember[];
  /** The oldest member's moment; null when no member has one. */
  since: string | null;
}

/** Lower is more urgent: failed and blocked, prompts, approvals, then setup. */
const SEVERITY: Record<NeedsRowKind, number> = {
  failed: 0,
  blocked: 0,
  prompt: 1,
  approval: 2,
  profile: 3,
  'terminal-setup': 3,
};

export const needsRowSeverity = (row: Pick<NeedsRow, 'kind'>): number =>
  SEVERITY[row.kind];

/** Setup needs repeat across projects; a slot, run or PR is one thing. */
const GROUPED: ReadonlySet<NeedsRowKind> = new Set([
  'profile',
  'terminal-setup',
]);

const member = (
  item: Pick<
    NeedsYouItem,
    'key' | 'projectId' | 'projectName' | 'reason' | 'href' | 'since'
  >,
): NeedsRowMember => ({
  key: item.key,
  projectId: item.projectId,
  projectName: item.projectName,
  reason: item.reason,
  href: item.href,
  since: item.since,
});

/** The earliest of the moments that exist, else null. */
function oldest(moments: readonly (string | null)[]): string | null {
  let best: string | null = null;
  for (const moment of moments) {
    if (moment === null) continue;
    if (best === null || Date.parse(moment) < Date.parse(best)) best = moment;
  }
  return best;
}

/**
 * Merges items with the same problem across projects into one row. Only setup
 * needs merge (same kind and title); a slot, run or PR keeps its own row.
 * Rows keep the order their first member had.
 */
export function groupNeeds(
  items: readonly NeedsYouItem[],
  setup: readonly TerminalSetupNeed[],
): NeedsRow[] {
  const rows: NeedsRow[] = [];
  const merged = new Map<string, NeedsRow>();
  const add = (
    kind: NeedsRowKind,
    title: string,
    key: string,
    one: NeedsRowMember,
  ) => {
    if (GROUPED.has(kind)) {
      const groupKey = `${kind}:${title}`;
      const existing = merged.get(groupKey);
      if (existing) {
        existing.members.push(one);
        existing.since = oldest(existing.members.map((m) => m.since));
        return;
      }
      const row: NeedsRow = {
        key: groupKey,
        kind,
        title,
        members: [one],
        since: one.since,
      };
      merged.set(groupKey, row);
      rows.push(row);
      return;
    }
    rows.push({ key, kind, title, members: [one], since: one.since });
  };
  for (const item of items) add(item.kind, item.title, item.key, member(item));
  for (const need of setup) {
    add(
      'terminal-setup',
      need.title,
      need.key,
      member({ ...need, since: null }),
    );
  }
  return rows;
}

/**
 * Most urgent first; within a severity, oldest first. A row with no moment
 * (a setup need) sorts after the dated ones of its severity. Stable.
 */
export function orderNeeds(rows: readonly NeedsRow[]): NeedsRow[] {
  const at = (row: NeedsRow) =>
    row.since === null ? Number.POSITIVE_INFINITY : Date.parse(row.since);
  return rows
    .map((row, index) => ({ row, index }))
    .sort(
      (a, b) =>
        needsRowSeverity(a.row) - needsRowSeverity(b.row) ||
        at(a.row) - at(b.row) ||
        a.index - b.index,
    )
    .map(({ row }) => row);
}

/** The rows the Needs-you block lists: grouped, then ordered. */
export const needsRows = (
  items: readonly NeedsYouItem[],
  setup: readonly TerminalSetupNeed[],
): NeedsRow[] => orderNeeds(groupNeeds(items, setup));

/** "8 projects", "1 project". */
export const projectsLabel = (count: number): string =>
  `${count} ${count === 1 ? 'project' : 'projects'}`;

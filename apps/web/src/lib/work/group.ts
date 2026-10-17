import {
  BOARD_COLUMNS,
  type BoardColumn,
  type WorkCardItem,
  type WorkItem,
} from '@agentdock/shared';

/** A fleet slot row: a `fleet` card that carries its issue. */
export type WorkFleetSlot = WorkCardItem & {
  source: 'fleet';
  fleet: NonNullable<WorkCardItem['fleet']>;
};

const isFleetSlot = (item: WorkItem): item is WorkFleetSlot =>
  item.source === 'fleet' && item.fleet !== undefined;

/**
 * #388: the slots of one issue, shown as one row. `status` is the least
 * advanced column among the slots the list holds (so it follows the status
 * filter, which the API applies per card); `updatedAt` is the latest of them.
 */
export interface WorkGroup {
  id: string;
  projectId: string;
  projectName: string;
  issue: number;
  title: string;
  slots: WorkFleetSlot[];
  status: BoardColumn;
  updatedAt: string;
}

export type WorkEntry =
  | { type: 'item'; item: WorkItem }
  | { type: 'group'; group: WorkGroup };

/** What the table renders, top to bottom: a row, a group, or a slot under an expanded group. */
export type WorkDisplayRow =
  | { type: 'item'; id: string; item: WorkItem }
  | { type: 'group'; id: string; group: WorkGroup; expanded: boolean }
  | { type: 'slot'; id: string; group: WorkGroup; item: WorkFleetSlot };

export const workGroupId = (projectId: string, issue: number): string =>
  `fleet:${projectId}:${issue}`;

const leastAdvanced = (slots: readonly WorkFleetSlot[]): BoardColumn =>
  slots.reduce<BoardColumn>(
    (least, slot) =>
      BOARD_COLUMNS.indexOf(slot.column) < BOARD_COLUMNS.indexOf(least)
        ? slot.column
        : least,
    slots[0]?.column ?? 'todo',
  );

const latest = (slots: readonly WorkFleetSlot[]): string =>
  slots.reduce(
    (at, slot) =>
      Date.parse(slot.updatedAt) > Date.parse(at) ? slot.updatedAt : at,
    slots[0]?.updatedAt ?? '',
  );

/**
 * Two or more fleet cards of one `(project, issue)` become one group, placed
 * where its first card was; a lone slot, and every other row, stays plain.
 */
export function groupWorkItems(items: readonly WorkItem[]): WorkEntry[] {
  const slotsByGroup = new Map<string, WorkFleetSlot[]>();
  for (const item of items) {
    if (!isFleetSlot(item)) continue;
    const id = workGroupId(item.projectId, item.fleet.issue);
    slotsByGroup.set(id, [...(slotsByGroup.get(id) ?? []), item]);
  }
  const placed = new Set<string>();
  const entries: WorkEntry[] = [];
  for (const item of items) {
    if (!isFleetSlot(item)) {
      entries.push({ type: 'item', item });
      continue;
    }
    const id = workGroupId(item.projectId, item.fleet.issue);
    const slots = slotsByGroup.get(id) ?? [item];
    if (slots.length < 2) {
      entries.push({ type: 'item', item });
      continue;
    }
    if (placed.has(id)) continue;
    placed.add(id);
    entries.push({
      type: 'group',
      group: {
        id,
        projectId: item.projectId,
        projectName: item.projectName,
        issue: item.fleet.issue,
        title: item.title,
        slots,
        status: leastAdvanced(slots),
        updatedAt: latest(slots),
      },
    });
  }
  return entries;
}

/** The entries as table rows; an expanded group is followed by one row per slot. */
export function displayRows(
  entries: readonly WorkEntry[],
  expanded: ReadonlySet<string>,
  rowId: (item: WorkItem) => string,
): WorkDisplayRow[] {
  return entries.flatMap((entry): WorkDisplayRow[] => {
    if (entry.type === 'item') {
      return [{ type: 'item', id: rowId(entry.item), item: entry.item }];
    }
    const { group } = entry;
    const open = expanded.has(group.id);
    return [
      { type: 'group', id: group.id, group, expanded: open },
      ...(open
        ? group.slots.map(
            (item): WorkDisplayRow => ({
              type: 'slot',
              id: rowId(item),
              group,
              item,
            }),
          )
        : []),
    ];
  });
}

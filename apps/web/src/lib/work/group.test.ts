import { describe, expect, test } from 'bun:test';
import type { BoardColumn, WorkCardItem, WorkItem } from '@agentdock/shared';
import { workRowId } from './format';
import { displayRows, groupWorkItems } from './group';

const slot = (
  number: number,
  issue: number,
  name: string | null,
  column: BoardColumn,
  updatedAt: string,
  projectId = 'p1',
): WorkCardItem => ({
  source: 'fleet',
  projectId,
  projectName: 'AgentDock',
  cardId: `card${number}`,
  number,
  label: `C-${number}`,
  title: `Issue ${issue}`,
  kind: 'feature',
  column,
  roundPhase: null,
  issueNumber: issue,
  issueUrl: null,
  prNumber: null,
  prUrl: null,
  updatedAt,
  href: `/projects/${projectId}/board?card=${number}`,
  fleet: { issue, slot: name, stage: null, slotGone: false },
});

const card = (number: number): WorkItem => ({
  ...slot(number, 7, null, 'todo', '2026-10-16T10:00:00.000Z'),
  source: 'card',
  fleet: undefined,
});

describe('groupWorkItems', () => {
  const items: WorkItem[] = [
    slot(37, 359, 'i359-api', 'in_progress', '2026-10-16T12:00:00.000Z'),
    card(1),
    slot(36, 359, 'i359-runner', 'finished', '2026-10-16T11:00:00.000Z'),
    slot(32, 359, 'i359-contract', 'completed', '2026-10-16T09:00:00.000Z'),
    slot(40, 400, 'i400-web', 'todo', '2026-10-16T08:00:00.000Z'),
  ];

  test('several slots of one issue make one group, a lone slot stays a plain row', () => {
    const entries = groupWorkItems(items);
    expect(entries.map((e) => e.type)).toEqual(['group', 'item', 'item']);
    const first = entries[0];
    if (first?.type !== 'group') throw new Error('expected a group');
    expect(first.group.slots.map((s) => s.label)).toEqual([
      'C-37',
      'C-36',
      'C-32',
    ]);
    const last = entries[2];
    expect(last?.type === 'item' && last.item.source).toBe('fleet');
  });

  test('status is the least advanced slot, updated the latest', () => {
    const [entry] = groupWorkItems(items);
    if (entry?.type !== 'group') throw new Error('expected a group');
    expect(entry.group.status).toBe('in_progress');
    expect(entry.group.updatedAt).toBe('2026-10-16T12:00:00.000Z');
  });

  test('the same issue in two projects is two rows', () => {
    const entries = groupWorkItems([
      slot(1, 5, 'a', 'todo', '2026-10-16T10:00:00.000Z', 'p1'),
      slot(2, 5, 'b', 'todo', '2026-10-16T09:00:00.000Z', 'p2'),
    ]);
    expect(entries.map((e) => e.type)).toEqual(['item', 'item']);
  });

  test('the group holds only the slots it is given, so a filter narrows it', () => {
    const entries = groupWorkItems(
      items.filter((i) => i.source === 'fleet' && i.column === 'completed'),
    );
    expect(entries.map((e) => e.type)).toEqual(['item']);
  });
});

describe('displayRows', () => {
  const entries = groupWorkItems([
    slot(37, 359, 'i359-api', 'in_progress', '2026-10-16T12:00:00.000Z'),
    slot(36, 359, 'i359-runner', 'finished', '2026-10-16T11:00:00.000Z'),
  ]);

  test('a collapsed group is one row', () => {
    const rows = displayRows(entries, new Set(), workRowId);
    expect(rows.map((r) => r.type)).toEqual(['group']);
  });

  test('an expanded group is followed by one row per slot', () => {
    const rows = displayRows(entries, new Set(['fleet:p1:359']), workRowId);
    expect(rows.map((r) => r.type)).toEqual(['group', 'slot', 'slot']);
    expect(new Set(rows.map((r) => r.id)).size).toBe(3);
  });
});

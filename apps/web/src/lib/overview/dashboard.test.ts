import { describe, expect, test } from 'bun:test';
import type {
  ActivityItem,
  ApprovalItemView,
  ApprovalsView,
  FleetView,
  ProjectSummary,
  SlotSummary,
} from '@agentdock/shared';
import {
  costByProject,
  lastSevenDays,
  mergedPullRequests,
  needsYou,
  nextHour,
  roundLabel,
  runningSlots,
  slotTitle,
  startOfToday,
  waitingApprovals,
} from './dashboard';

const project = (id: string): ProjectSummary => ({
  id,
  displayName: `Project ${id}`,
  repo: `o/${id}`,
  rootPath: `/srv/${id}`,
  runnerId: 'r1',
  runnerName: 'runner',
  runnerStatus: 'online',
  base: 'main',
  docsKind: null,
  role: 'operator',
});

const slot = (over: Partial<SlotSummary>): SlotSummary => ({
  id: 's',
  name: 'i1',
  issue: null,
  branch: null,
  runtime: 'claude',
  model: null,
  modelWhy: null,
  lead: null,
  status: 'running',
  round: null,
  lastCheckpoint: null,
  prNumber: null,
  prUrl: null,
  prChecks: null,
  ahead: null,
  behind: null,
  dirty: null,
  startedAt: '2026-10-13T08:00:00.000Z',
  endedAt: null,
  updatedAt: '2026-10-13T09:00:00.000Z',
  ...over,
});

const fleet = (projectId: string, slots: SlotSummary[]): FleetView => ({
  projectId,
  fleetChannel: 'events',
  orchestrator: { status: 'running', session: null, since: null },
  base: 'main',
  latestRound: null,
  boardError: null,
  slots,
});

const approval = (over: Partial<ApprovalItemView>): ApprovalItemView => ({
  id: 'a',
  pr: 7,
  title: null,
  url: null,
  slot: null,
  issue: null,
  checks: null,
  mergeable: null,
  summary: null,
  source: 'orchestrator',
  status: 'waiting',
  headSha: null,
  waitingSince: '2026-10-13T07:00:00.000Z',
  decidedBy: null,
  decidedAt: null,
  note: null,
  updatedAt: '2026-10-13T07:00:00.000Z',
  ...over,
});

const approvals = (waiting: ApprovalItemView[]): ApprovalsView => ({
  mergeApproval: { agentdock: true, config: true },
  configMismatch: false,
  waiting,
  recent: [],
});

const activity = (over: Partial<ActivityItem>): ActivityItem => ({
  id: '1',
  ts: '2026-10-13T10:00:00.000Z',
  projectId: 'p1',
  category: 'fleet',
  type: 'pr.merged',
  severity: 'ok',
  title: 'PR merged',
  actorType: 'orchestrator',
  actorId: null,
  actorEmail: null,
  slot: null,
  issue: null,
  prNumber: 5,
  link: null,
  data: {},
  ...over,
});

describe('ranges', () => {
  const now = new Date(2026, 9, 13, 14, 25);
  test('today starts at local midnight', () => {
    expect(startOfToday(now)).toBe(new Date(2026, 9, 13).toISOString());
  });
  test('the range ends at the next full hour, so now is included', () => {
    expect(nextHour(now)).toBe(new Date(2026, 9, 13, 15).toISOString());
  });
  test('seven days are today and the six before it', () => {
    expect(lastSevenDays(now).from).toBe(new Date(2026, 9, 7).toISOString());
  });
});

describe('figures', () => {
  test('running slots count live sessions only', () => {
    const fleets = [
      fleet('p1', [
        slot({ status: 'running' }),
        slot({ status: 'prompt' }),
        slot({ status: 'stale' }),
        slot({ status: 'dispatched' }),
      ]),
      fleet('p2', [slot({ status: 'quota' })]),
    ];
    expect(runningSlots(fleets)).toBe(3);
  });

  test('approvals waiting leave out the approved-but-unmerged row', () => {
    expect(
      waitingApprovals([
        approvals([approval({}), approval({ id: 'b', status: 'approved' })]),
        approvals([approval({ id: 'c' })]),
      ]),
    ).toBe(2);
  });

  test('a merge reported twice counts once', () => {
    expect(
      mergedPullRequests([
        activity({ id: '1' }),
        activity({ id: '2' }),
        activity({ id: '3', projectId: 'p2' }),
        activity({ id: '4', prNumber: 6 }),
        activity({ id: '5', type: 'pr.opened', prNumber: 9 }),
      ]),
    ).toBe(3);
  });
});

describe('needsYou', () => {
  test('blocked slots, prompts and waiting approvals, oldest first', () => {
    const items = needsYou(
      [project('p1')],
      new Map([
        [
          'p1',
          fleet('p1', [
            slot({
              id: 's1',
              name: 'i4',
              issue: 4,
              lastCheckpoint: 'blocked',
              updatedAt: '2026-10-13T09:00:00.000Z',
            }),
            slot({
              id: 's2',
              status: 'prompt',
              updatedAt: '2026-10-13T08:00:00.000Z',
            }),
            slot({ id: 's3', status: 'running' }),
            slot({ id: 's4', status: 'ended', lastCheckpoint: 'blocked' }),
          ]),
        ],
      ]),
      new Map([
        [
          'p1',
          approvals([
            approval({ title: 'fix login' }),
            approval({ id: 'b', status: 'approved' }),
          ]),
        ],
      ]),
    );
    expect(items.map((i) => [i.kind, i.title])).toEqual([
      ['approval', 'PR #7 · fix login'],
      ['prompt', 'Slot i1'],
      ['blocked', 'Slot i4 · #4'],
    ]);
    expect(items[0]?.href).toBe('/projects/p1/approvals');
    expect(items[2]?.projectName).toBe('Project p1');
  });

  test('a project whose fleet did not load contributes nothing', () => {
    expect(needsYou([project('p1')], new Map(), new Map())).toEqual([]);
  });
});

describe('labels', () => {
  test('slot titles name the issue when there is one', () => {
    expect(slotTitle({ name: 'i9', issue: null })).toBe('Slot i9');
    expect(slotTitle({ name: 'i9', issue: 9 })).toBe('Slot i9 · #9');
  });

  test('a round reads as its start and occupancy', () => {
    expect(
      roundLabel(
        {
          id: 'r',
          date: '2026-10-13',
          label: '1405',
          base: 'main',
          occupied: 3,
          max: 5,
          free: 2,
          source: 'events',
          boardPath: '',
          createdAt: '',
        },
        () => 'Oct 13',
      ),
    ).toBe('Round Oct 13, 14:05 · 3 of 5 slots');
    expect(roundLabel(null, () => '')).toBeNull();
  });
});

describe('costByProject', () => {
  test('keys by project id and skips the project-less series', () => {
    const map = costByProject({
      series: [
        {
          key: 'p1',
          label: 'P1',
          points: [
            {
              t: 'a',
              costUsd: '1.5',
              tokens: 0,
              requests: 0,
              unpricedRequests: 0,
            },
            {
              t: 'b',
              costUsd: 'NaN',
              tokens: 0,
              requests: 0,
              unpricedRequests: 0,
            },
          ],
        },
        { key: null, label: null, points: [] },
      ],
    });
    expect([...map.keys()]).toEqual(['p1']);
    expect(map.get('p1')).toEqual([1.5, 0]);
  });
});

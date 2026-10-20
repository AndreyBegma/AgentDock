import { describe, expect, test } from 'bun:test';
import type {
  ActivityItem,
  ApprovalItemView,
  ApprovalsView,
  FleetView,
  ProjectSummary,
  RunSummary,
  SlotSummary,
} from '@agentdock/shared';
import {
  approvalsHref,
  costByProject,
  lastSevenDays,
  mergedPullRequests,
  mergedTodayHref,
  needsYou,
  nextHour,
  OVERVIEW_TILE_HREF,
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
  watchRefusal: null,
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

const run = (over: Partial<RunSummary>): RunSummary => ({
  id: 'r',
  kind: 'orchestrator_slot',
  projectId: 'p1',
  slotId: 's7',
  slot: 'i7',
  issue: 7,
  title: null,
  runtime: 'claude',
  model: null,
  profileKey: null,
  output: 'pr',
  status: 'failed',
  outcome: null,
  prNumber: null,
  prUrl: null,
  prChecks: null,
  planId: null,
  triggeredByType: 'orchestrator',
  triggeredById: null,
  startedAt: '2026-10-14T05:00:00.000Z',
  endedAt: '2026-10-14T08:00:00.000Z',
  durationMs: null,
  updatedAt: '2026-10-14T08:00:00.000Z',
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    reasoning: 0,
    requests: 0,
    costUsd: null,
    unpricedRequests: 0,
  },
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
    expect(items[0]?.href).toBe('/projects/p1/queue?tab=approvals');
    expect(items[2]?.projectName).toBe('Project p1');
  });

  test('a project whose fleet did not load contributes nothing', () => {
    expect(needsYou([project('p1')], new Map(), new Map())).toEqual([]);
  });

  test('a blocked slot deep-links to itself on the Fleet (#213)', () => {
    const [item] = needsYou(
      [project('p1')],
      new Map([
        ['p1', fleet('p1', [slot({ name: 'i4', lastCheckpoint: 'blocked' })])],
      ]),
      new Map(),
    );
    expect(item?.href).toBe('/projects/p1/fleet?open=i4&focus=i4');
  });

  test('runs failed in the last 24 h, and a missing profile first (#213)', () => {
    const now = Date.parse('2026-10-14T12:00:00.000Z');
    const items = needsYou(
      [project('p1'), project('p2')],
      new Map(),
      new Map(),
      {
        now,
        failedRuns: new Map([
          [
            'p1',
            [
              run({ id: 'fresh', endedAt: '2026-10-14T06:00:00.000Z' }),
              run({ id: 'old', endedAt: '2026-10-13T06:00:00.000Z' }),
              run({ id: 'ok', status: 'succeeded' }),
              run({ id: 'titled', slot: null, title: 'Nightly audit' }),
              run({ id: 'skill', kind: 'skill', slot: null, title: null }),
            ],
          ],
        ]),
        missingProfile: new Set(['p2']),
      },
    );
    expect(items.map((i) => [i.kind, i.key])).toEqual([
      ['profile', 'profile:p2'],
      ['failed', 'failed:fresh'],
      ['failed', 'failed:titled'],
      ['failed', 'failed:skill'],
    ]);
    expect(items[3]?.title).toBe('Skill run');
    expect(items[0]?.href).toBe('/projects/p2/settings?tab=orchestrator');
    expect(items[0]?.since).toBeNull();
    expect(items[1]?.title).toBe('Slot i7 · #7');
    expect(items[1]?.href).toBe('/projects/p1/history/fresh');
    expect(items[2]?.title).toBe('Nightly audit');
  });
});

describe('tile links (#213)', () => {
  test('cost today is the Usage contract, merged is Activity filtered to today', () => {
    expect(OVERVIEW_TILE_HREF.cost).toBe('/usage?range=today');
    expect(mergedTodayHref(new Date(2026, 9, 4, 23, 30))).toBe(
      '/activity?type=pr.merged&from=2026-10-04',
    );
  });

  test('approvals open the first project with one waiting, else Projects', () => {
    const waiting = approvals([approval({})]);
    const decided = approvals([approval({ status: 'approved' })]);
    expect(
      approvalsHref(
        [project('p1'), project('p2')],
        new Map([
          ['p1', decided],
          ['p2', waiting],
        ]),
      ),
    ).toBe('/projects/p2/queue?tab=approvals');
    expect(approvalsHref([project('p1')], new Map([['p1', decided]]))).toBe(
      '/projects',
    );
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
    ).toBe('Round Oct 13, 14:05 · up to 5 slots');
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

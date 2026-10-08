import type { QueueVerdict } from '@agentdock/shared';
import {
  type CachedIssue,
  computeQueue,
  type QueueInputs,
  type QueueSlot,
} from './queue-state';

const AC = '## Acceptance criteria\n- [ ] it works\n';
const SNAPSHOT = new Date('2026-10-08T10:00:00Z');

const issue = (
  number: number,
  overrides: Partial<CachedIssue> = {},
): CachedIssue => ({
  number,
  kind: 'issue',
  title: `Issue ${number}`,
  state: 'open',
  labels: ['cs:ready'],
  body: AC,
  closedBy: null,
  snapshotAt: SNAPSHOT,
  ...overrides,
});

const inputs = (overrides: Partial<QueueInputs>): QueueInputs => ({
  readyLabel: 'cs:ready',
  issues: [],
  slots: [],
  round: null,
  ...overrides,
});

const stateOf = (input: QueueInputs, number = 1) =>
  computeQueue(input).find((i) => i.number === number);

/**
 * The fixture snapshot of the acceptance criteria: one row per D3 state,
 * each issue alone with whatever it needs around it.
 */
describe('computeQueue — D3, one row per acceptance criterion', () => {
  const slot = (overrides: Partial<QueueSlot>): QueueSlot => ({
    name: 'i1-api',
    issue: null,
    branch: null,
    live: true,
    ...overrides,
  });

  it.each<{
    name: string;
    issues: CachedIssue[];
    slots?: QueueSlot[];
    state: string;
    why: RegExp;
    blockers?: number[];
  }>([
    {
      name: '`Depends on #m` with m open → BLOCKED — work naming #m',
      issues: [
        issue(1, { body: `${AC}\nDepends on #2\n` }),
        issue(2, { labels: [] }),
      ],
      state: 'blocked_work',
      why: /#2, which is open/,
      blockers: [2],
    },
    {
      name: '`Gate:` line → BLOCKED — person quoting it',
      issues: [issue(1, { body: `${AC}\nGate: the owner signs off\n` })],
      state: 'blocked_person',
      why: /^Gate: the owner signs off$/,
    },
    {
      name: 'no acceptance criteria → NO SPEC',
      issues: [issue(1, { body: 'Make it better.' })],
      state: 'no_spec',
      why: /no acceptance criteria/,
    },
    {
      name: '`size: XL` without `## Parallel plan` → NO SPEC',
      issues: [issue(1, { labels: ['cs:ready', 'size: XL'] })],
      state: 'no_spec',
      why: /Parallel plan/,
    },
    {
      name: 'an open PR with `Closes #n` → IN FLIGHT',
      issues: [
        issue(1),
        issue(7, { kind: 'pull_request', labels: [], body: 'Closes #1' }),
      ],
      state: 'in_flight',
      why: /pull request #7 closes it/,
    },
    {
      name: 'otherwise → READY',
      issues: [issue(1)],
      state: 'ready',
      why: /nothing blocks it/,
    },
  ])('$name', ({ issues, slots, state, why, blockers }) => {
    const item = stateOf(inputs({ issues, slots: slots ?? [] }));
    expect(item?.source).toBe('computed');
    expect(item?.shown.state).toBe(state);
    expect(item?.shown.why).toMatch(why);
    expect(item?.blockers).toEqual(blockers ?? []);
  });

  it('IN FLIGHT also for a live slot carrying it, by issue or by branch, and for the label', () => {
    const one = [issue(1)];
    expect(
      stateOf(inputs({ issues: one, slots: [slot({ issue: 1 })] }))?.shown,
    ).toMatchObject({ state: 'in_flight', why: 'slot i1-api carries it' });
    expect(
      stateOf(inputs({ issues: one, slots: [slot({ branch: 'feat/1-x' })] }))
        ?.shown.state,
    ).toBe('in_flight');
    expect(
      stateOf(inputs({ issues: one, slots: [slot({ issue: 1, live: false })] }))
        ?.shown.state,
    ).toBe('ready');
    expect(
      stateOf(
        inputs({ issues: [issue(1, { labels: ['cs:ready', 'cs:in-flight'] })] }),
      )?.shown.state,
    ).toBe('in_flight');
  });

  it('a closed or draft-less pull request does not put an issue in flight', () => {
    const item = stateOf(
      inputs({
        issues: [
          issue(1),
          issue(7, {
            kind: 'pull_request',
            state: 'closed',
            labels: [],
            body: 'Closes #1',
          }),
        ],
      }),
    );
    expect(item?.shown.state).toBe('ready');
  });

  it('follows the precedence: in flight > person > work > no spec', () => {
    const everything = issue(1, {
      body: 'Gate: x\nDepends on #2',
      labels: ['cs:ready', 'cs:in-flight'],
    });
    const at = (i: CachedIssue) =>
      stateOf(inputs({ issues: [i, issue(2, { labels: [] })] }))?.shown.state;
    expect(at(everything)).toBe('in_flight');
    expect(at({ ...everything, labels: ['cs:ready'] })).toBe('blocked_person');
    expect(at({ ...everything, labels: ['cs:ready'], body: 'Depends on #2' })).toBe(
      'blocked_work',
    );
  });

  it('BLOCKED — person for the cs:needs-person label', () => {
    expect(
      stateOf(
        inputs({
          issues: [issue(1, { labels: ['cs:ready', 'cs:needs-person'] })],
        }),
      )?.shown.state,
    ).toBe('blocked_person');
  });
});

describe('computeQueue — how a dependency was closed', () => {
  const dependant = issue(1, { body: `${AC}\nDepends on #2\n` });
  const closed = (closedBy: CachedIssue['closedBy']) =>
    stateOf(
      inputs({
        issues: [dependant, issue(2, { state: 'closed', labels: [], closedBy })],
      }),
    );

  it('a dependency closed by a merged PR unblocks its dependants', () => {
    expect(closed('pr')?.shown).toMatchObject({
      state: 'ready',
      why: '#2 merged; nothing else blocks it',
    });
  });

  it('one closed manually keeps them BLOCKED — work', () => {
    expect(closed('manual')?.shown).toMatchObject({
      state: 'blocked_work',
      why: 'depends on #2, which was closed without a merged pull request',
    });
  });

  it('one closed but not yet reported, or never seen, still blocks', () => {
    expect(closed(null)?.shown.state).toBe('blocked_work');
    expect(stateOf(inputs({ issues: [dependant] }))?.blockers).toEqual([2]);
  });
});

describe('computeQueue — the orchestrator verdict (D4)', () => {
  const verdict: QueueVerdict = {
    state: 'blocked_work',
    why: 'touches a file #9 changes',
    clears: '#9 merges',
  };
  const withRound = (updatedAt: Date) =>
    stateOf(
      inputs({
        issues: [issue(1)],
        round: { updatedAt, verdicts: new Map([[1, verdict]]) },
      }),
    );

  it('wins when the round is newer than the snapshot, with the computed state alongside', () => {
    const item = withRound(new Date('2026-10-08T10:05:00Z'));
    expect(item?.source).toBe('orchestrator');
    expect(item?.shown).toEqual(verdict);
    expect(item?.computed.state).toBe('ready');
  });

  it('loses when the issue changed after the round', () => {
    const item = withRound(new Date('2026-10-08T09:55:00Z'));
    expect(item?.source).toBe('computed');
    expect(item?.shown.state).toBe('ready');
    expect(item?.orchestrator).toEqual(verdict);
  });
});

describe('computeQueue — scope and order (D6)', () => {
  it('lists only open issues with the ready label, ignoring its case', () => {
    const items = computeQueue(
      inputs({
        readyLabel: 'agent:ready',
        issues: [
          issue(1, { labels: ['Agent:Ready'] }),
          issue(2, { labels: ['cs:ready'] }),
          issue(3, { labels: ['agent:ready'], state: 'closed' }),
          issue(4, { labels: ['agent:ready'], kind: 'pull_request' }),
        ],
      }),
    );
    expect(items.map((i) => i.number)).toEqual([1]);
  });

  it('orders by priority label, then by number', () => {
    const items = computeQueue(
      inputs({
        issues: [
          issue(5),
          issue(9, { labels: ['cs:ready', 'priority: medium'] }),
          issue(8, { labels: ['cs:ready', 'priority: critical'] }),
          issue(3),
        ],
      }),
    );
    expect(items.map((i) => i.number)).toEqual([8, 9, 3, 5]);
  });

  it('lists the wave slots of a parallel plan', () => {
    const body = `${AC}\n## Parallel plan\n| Slot | Lead | Model |\n|---|---|---|\n| i1-api | yes | opus |\n`;
    expect(stateOf(inputs({ issues: [issue(1, { body })] }))?.waveSlots).toEqual(
      [{ slot: 'i1-api', lead: true, model: 'opus' }],
    );
  });
});

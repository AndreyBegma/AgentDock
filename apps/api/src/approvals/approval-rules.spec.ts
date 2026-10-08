import type { RunnerEvent } from '@agentdock/shared/protocol';
import {
  AWAITING_APPROVAL_EVENT,
  awaitsByDerivation,
  type PrPlanInput,
  type PrTouch,
  planPr,
  readApprovalEvents,
  type SlotState,
} from './approval-rules';

const ROOT = '/srv/dev/widget';
let seq = 0;
const event = (
  type: string,
  data: unknown,
  extra: Partial<RunnerEvent> = {},
): RunnerEvent => {
  seq += 1;
  return {
    v: 1,
    seq,
    ts: new Date(Date.UTC(2026, 9, 8, 10, 0, seq)).toISOString(),
    type,
    source: 'runner',
    project: { repo: 'acme/widget', root: ROOT },
    data,
    ...extra,
  };
};

const green: SlotState = {
  prState: 'open',
  prChecks: 'green',
  prMergeable: true,
  ended: false,
  prOpenCheckpoint: true,
};

const touch = (over: Partial<PrTouch> = {}): PrTouch => ({
  awaiting: null,
  closed: null,
  moved: false,
  ...over,
});

const input = (over: Partial<PrPlanInput> = {}): PrPlanInput => ({
  touch: touch(),
  current: null,
  slot: { name: 'i42', issue: 42, state: green },
  deriveAllowed: false,
  now: '2026-10-08T12:00:00.000Z',
  ...over,
});

describe('readApprovalEvents', () => {
  it('reads the plugin event raw, by data.pr, with the envelope slot and issue', () => {
    const roots = readApprovalEvents([
      event(
        AWAITING_APPROVAL_EVENT,
        { pr: 51 },
        { source: 'code-sentinel', slot: 'i42', issue: 42 },
      ),
    ]);
    const root = roots.get(ROOT);
    expect(root?.pluginEvent).toBe(true);
    expect(root?.prs.get(51)?.awaiting).toMatchObject({
      slot: 'i42',
      issue: 42,
    });
  });

  it('skips an awaiting event without a PR number', () => {
    const roots = readApprovalEvents([
      event(AWAITING_APPROVAL_EVENT, { slot: 'i42' }),
    ]);
    expect(roots.get(ROOT)?.prs.size ?? 0).toBe(0);
  });

  it('marks checks, merges and closes; a pr.closed with merged is a merge', () => {
    const roots = readApprovalEvents([
      event('pr.checks_changed', { number: 1, branch: 'b', checks: 'green' }),
      event('pr.closed', { number: 2, branch: 'b', merged: true }),
      event('pr.closed', { number: 3, branch: 'b' }),
      event('pr.merged', { number: 4 }),
    ]);
    const prs = roots.get(ROOT)?.prs;
    expect(prs?.get(1)?.moved).toBe(true);
    expect(prs?.get(2)?.closed).toBe('merged');
    expect(prs?.get(3)?.closed).toBe('closed');
    expect(prs?.get(4)?.closed).toBe('merged');
  });

  it('keeps a pull-request-open checkpoint without a number by its slot', () => {
    const roots = readApprovalEvents([
      event(
        'slot.checkpoint',
        { checkpoint: 'pr_open', summary: 'done' },
        { slot: 'i42' },
      ),
    ]);
    expect([...(roots.get(ROOT)?.checkpointSlots ?? [])]).toEqual(['i42']);
  });
});

describe('awaitsByDerivation (D2)', () => {
  it('needs green, mergeable, open, a pr_open checkpoint and a live slot', () => {
    expect(awaitsByDerivation(green)).toBe(true);
    expect(awaitsByDerivation({ ...green, prChecks: 'pending' })).toBe(false);
    expect(awaitsByDerivation({ ...green, prMergeable: null })).toBe(false);
    expect(awaitsByDerivation({ ...green, prState: 'merged' })).toBe(false);
    expect(awaitsByDerivation({ ...green, prOpenCheckpoint: false })).toBe(
      false,
    );
    expect(awaitsByDerivation({ ...green, ended: true })).toBe(false);
  });
});

describe('planPr', () => {
  const awaiting = { slot: 'i42', issue: 42, ts: '2026-10-08T10:00:00.000Z' };

  it('opens an orchestrator row on pr.awaiting_approval', () => {
    expect(planPr(input({ touch: touch({ awaiting }) }))).toEqual([
      {
        kind: 'create',
        source: 'orchestrator',
        slot: 'i42',
        issue: 42,
        waitingSince: awaiting.ts,
      },
    ]);
  });

  it('adopts a derived row as the orchestrator’s, and does not duplicate a current one', () => {
    expect(
      planPr(
        input({
          touch: touch({ awaiting }),
          current: { id: 'r1', status: 'waiting', source: 'derived' },
        }),
      ),
    ).toEqual([{ kind: 'adopt', rowId: 'r1', slot: 'i42', issue: 42 }]);
    expect(
      planPr(
        input({
          touch: touch({ awaiting }),
          current: { id: 'r1', status: 'approved', source: 'orchestrator' },
        }),
      ),
    ).toEqual([]);
  });

  it('derives a row only when allowed and the slot qualifies', () => {
    const moved = touch({ moved: true });
    expect(planPr(input({ touch: moved, deriveAllowed: true }))).toEqual([
      {
        kind: 'create',
        source: 'derived',
        slot: 'i42',
        issue: 42,
        waitingSince: '2026-10-08T12:00:00.000Z',
      },
    ]);
    expect(planPr(input({ touch: moved, deriveAllowed: false }))).toEqual([]);
    expect(
      planPr(
        input({
          touch: moved,
          deriveAllowed: true,
          slot: {
            name: 'i42',
            issue: 42,
            state: { ...green, prChecks: 'red' },
          },
        }),
      ),
    ).toEqual([]);
  });

  it('does not derive without a move — a PR sent back is listed again only when it moves', () => {
    expect(planPr(input({ deriveAllowed: true }))).toEqual([]);
  });

  it('drops an undecided waiting row whose slot is no longer green', () => {
    expect(
      planPr(
        input({
          touch: touch({ moved: true }),
          current: { id: 'r1', status: 'waiting', source: 'orchestrator' },
          slot: {
            name: 'i42',
            issue: 42,
            state: { ...green, prChecks: 'pending' },
          },
        }),
      ),
    ).toEqual([{ kind: 'drop', rowId: 'r1' }]);
  });

  it('re-reads the head of an approved PR that moved (D6)', () => {
    expect(
      planPr(
        input({
          touch: touch({ moved: true }),
          current: { id: 'r1', status: 'approved', source: 'orchestrator' },
        }),
      ),
    ).toEqual([{ kind: 'checkHead', rowId: 'r1' }]);
  });

  it('closes the current row on merge or close, and opens nothing', () => {
    const current = {
      id: 'r1',
      status: 'approved' as const,
      source: 'orchestrator' as const,
    };
    expect(
      planPr(input({ touch: touch({ closed: 'merged', awaiting }), current })),
    ).toEqual([{ kind: 'close', rowId: 'r1', status: 'merged' }]);
    expect(planPr(input({ touch: touch({ closed: 'closed' }) }))).toEqual([]);
  });

  it('turns a closed row into a merged one when the merge is reported late', () => {
    expect(
      planPr(input({ touch: touch({ closed: 'merged' }), closedRowId: 'r0' })),
    ).toEqual([{ kind: 'close', rowId: 'r0', status: 'merged' }]);
  });
});

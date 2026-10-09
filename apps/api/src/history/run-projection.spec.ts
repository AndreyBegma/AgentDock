import type { Slot } from '@prisma/client';
import { runOfSlot } from './run-projection';

const at = (minutes: number) =>
  new Date(Date.parse('2026-10-08T10:00:00Z') + minutes * 60_000);

const slot = (fields: Partial<Slot> = {}): Slot => ({
  id: 'slot-1',
  projectId: 'p1',
  name: 'i21',
  issue: 21,
  branch: 'feat/21',
  worktree: '/srv/dev/.wt-widget-i21',
  runtime: 'claude',
  model: 'opus',
  modelWhy: null,
  owns: [],
  never: [],
  lead: true,
  round: null,
  status: 'running',
  sessionAlive: true,
  pane: 'busy',
  worktreeExists: true,
  ahead: null,
  behind: null,
  dirty: null,
  prNumber: null,
  prUrl: null,
  prState: null,
  prChecks: null,
  prMergeable: null,
  lastCheckpoint: null,
  sources: {},
  lastSeq: 5n,
  startedAt: at(0),
  endedAt: null,
  updatedAt: at(10),
  ...fields,
});

describe('runOfSlot (spec 21 D7)', () => {
  it('copies the slot into an open run', () => {
    expect(runOfSlot(slot(), 'planned')).toEqual({
      kind: 'orchestrator_slot',
      projectId: 'p1',
      slotId: 'slot-1',
      issue: 21,
      runtime: 'claude',
      model: 'opus',
      output: null,
      status: 'running',
      outcome: 'planned',
      prNumber: null,
      prUrl: null,
      triggeredByType: 'orchestrator',
      startedAt: at(0),
      endedAt: null,
      durationMs: null,
      slotSeq: 5n,
      updatedAt: at(10),
    });
  });

  it('ends a merged run when the slot ended', () => {
    const run = runOfSlot(
      slot({
        status: 'ended',
        prState: 'merged',
        prNumber: 7,
        endedAt: at(45),
      }),
      null,
    );
    expect(run).toMatchObject({
      status: 'succeeded',
      output: 'pr',
      endedAt: at(45),
      durationMs: 45 * 60_000,
    });
  });

  it('ends an abandoned stale slot at its last change', () => {
    const run = runOfSlot(slot({ status: 'stale', sessionAlive: false }), '');
    expect(run).toMatchObject({
      status: 'abandoned',
      outcome: null,
      endedAt: at(10),
      durationMs: 10 * 60_000,
    });
  });

  it('is the same row for the same slot', () => {
    expect(runOfSlot(slot(), 'x')).toEqual(runOfSlot(slot(), 'x'));
  });
});

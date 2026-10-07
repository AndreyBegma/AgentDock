import type { PaneState, PrState } from '@agentdock/shared';
import type {
  CheckpointKind,
  PrChecks,
  SlotRuntime,
} from '@agentdock/shared/protocol';
import type { Slot } from '@prisma/client';
import {
  type Applied,
  type Changes,
  type EventOf,
  type ProjectRef,
  type Tx,
  worktreePath,
} from './projection';
import { deriveSlotStatus } from './slot-status';

/** The columns a slot event may set; `status` and `endedAt` follow from them. */
interface SlotPatch {
  issue?: number;
  branch?: string;
  worktree?: string;
  runtime?: SlotRuntime;
  model?: string | null;
  modelWhy?: string | null;
  owns?: string[];
  never?: string[];
  lead?: boolean | null;
  round?: string;
  sessionAlive?: boolean;
  pane?: PaneState | null;
  worktreeExists?: boolean;
  ahead?: number | null;
  behind?: number | null;
  dirty?: boolean | null;
  prNumber?: number;
  prUrl?: string;
  prState?: PrState;
  prChecks?: PrChecks;
  prMergeable?: boolean | null;
  lastCheckpoint?: CheckpointKind;
}

export type SlotEvent = EventOf<
  | 'session.appeared'
  | 'session.vanished'
  | 'pane.prompt'
  | 'pane.idle'
  | 'pane.quota_hit'
  | 'pane.busy'
  | 'worktree.changed'
  | 'slot.dispatched'
  | 'slot.checkpoint'
  | 'pr.opened'
  | 'pr.checks_changed'
  | 'pr.closed'
>;

const PANE_OF = {
  'pane.prompt': 'prompt',
  'pane.idle': 'idle',
  'pane.quota_hit': 'quota',
  'pane.busy': 'busy',
} as const satisfies Record<string, PaneState>;

/**
 * Projects slot events into `slots` and `slot_checkpoints` (spec 11 D8).
 *
 * A slot name is reused by later runs, each its own row. An event belongs to
 * the run that covers its `ts` — the latest row started at or before it. Only
 * a session appearing or a brief can start a run. An event at or below the
 * run's `lastSeq` was applied already, so a replay changes nothing.
 */
export class SlotProjection {
  constructor(
    private readonly tx: Tx,
    private readonly project: ProjectRef,
    private readonly changed: Changes,
  ) {}

  async apply(applied: Applied<SlotEvent>): Promise<void> {
    const { event } = applied;
    switch (event.type) {
      case 'session.appeared':
        return this.sessionAppeared(applied as Applied<typeof event>);
      case 'slot.dispatched':
        return this.dispatched(applied as Applied<typeof event>);
      case 'slot.checkpoint':
        return this.checkpoint(applied as Applied<typeof event>);
      case 'pr.opened':
      case 'pr.checks_changed':
      case 'pr.closed':
        return this.pullRequest(applied as Applied<typeof event>);
      default: {
        const row = await this.covering(this.slotName(event), applied.ts);
        if (!row || applied.seq <= row.lastSeq) return;
        return this.update(row, applied, this.patchOf(event));
      }
    }
  }

  private patchOf(
    event: Exclude<
      SlotEvent,
      EventOf<
        | 'session.appeared'
        | 'slot.dispatched'
        | 'slot.checkpoint'
        | 'pr.opened'
        | 'pr.checks_changed'
        | 'pr.closed'
      >
    >,
  ): SlotPatch {
    switch (event.type) {
      case 'session.vanished':
        return { sessionAlive: false, pane: null };
      case 'worktree.changed': {
        const { data } = event;
        if (!data.exists) return { worktreeExists: false, worktree: data.path };
        return {
          worktreeExists: true,
          worktree: data.path,
          ...(data.branch ? { branch: data.branch } : {}),
          ahead: data.ahead ?? null,
          behind: data.behind ?? null,
          dirty: data.dirty ?? null,
        };
      }
      default:
        return { pane: PANE_OF[event.type] };
    }
  }

  private async sessionAppeared(
    applied: Applied<EventOf<'session.appeared'>>,
  ): Promise<void> {
    const patch: SlotPatch = { sessionAlive: true, pane: null };
    const row = await this.covering(this.slotName(applied.event), applied.ts);
    if (row && applied.seq <= row.lastSeq) return;
    if (!row || row.status === 'ended') {
      return this.create(applied, patch);
    }
    return this.update(row, applied, patch);
  }

  /**
   * A brief starts a run unless one already carries its round, or the covering
   * run has no brief yet (its session appeared first) or is still waiting for
   * its session (the brief was rewritten before launch).
   */
  private async dispatched(
    applied: Applied<EventOf<'slot.dispatched'>>,
  ): Promise<void> {
    const { event } = applied;
    const { data } = event;
    const round = `${data.date}/${data.round}`;
    const patch: SlotPatch = {
      round,
      runtime: data.runtime,
      model: data.model ?? null,
      modelWhy: data.modelWhy ?? null,
      owns: data.owns,
      never: data.never,
      lead: data.lead ?? null,
      ...(data.branch ? { branch: data.branch } : {}),
      ...(data.worktree ? { worktree: data.worktree } : {}),
    };
    const name = this.slotName(event);
    const sameRound = await this.tx.slot.findFirst({
      where: { projectId: this.project.id, name, round },
      orderBy: { startedAt: 'desc' },
    });
    const row = sameRound ?? (await this.covering(name, applied.ts));
    if (row && applied.seq <= row.lastSeq) return;
    const newRun =
      !row ||
      (!sameRound &&
        (row.status === 'ended' ||
          (row.round !== null && row.status !== 'dispatched')));
    if (newRun) return this.create(applied, patch);
    return this.update(row, applied, patch);
  }

  private async checkpoint(
    applied: Applied<EventOf<'slot.checkpoint'>>,
  ): Promise<void> {
    const { event } = applied;
    const row = await this.covering(this.slotName(event), applied.ts);
    if (!row || applied.seq <= row.lastSeq) return;
    const { data } = event;
    const fields = {
      kind: data.checkpoint,
      heading: data.heading,
      summary: data.summary,
    };
    await this.tx.slotCheckpoint.upsert({
      where: { slotId_position: { slotId: row.id, position: data.position } },
      create: {
        slotId: row.id,
        position: data.position,
        at: applied.ts,
        ...fields,
      },
      update: fields,
    });
    const last = await this.tx.slotCheckpoint.findFirstOrThrow({
      where: { slotId: row.id },
      orderBy: { position: 'desc' },
      select: { kind: true },
    });
    return this.update(row, applied, {
      lastCheckpoint: last.kind,
      ...(data.prUrl ? { prUrl: data.prUrl } : {}),
    });
  }

  /** A PR belongs to the event's slot, else to the latest run on its branch. */
  private async pullRequest(
    applied: Applied<EventOf<'pr.opened' | 'pr.checks_changed' | 'pr.closed'>>,
  ): Promise<void> {
    const { event } = applied;
    const row = event.slot
      ? await this.covering(event.slot, applied.ts)
      : await this.tx.slot.findFirst({
          where: { projectId: this.project.id, branch: event.data.branch },
          orderBy: { startedAt: 'desc' },
        });
    if (!row || applied.seq <= row.lastSeq) return;
    const patch: SlotPatch = { prNumber: event.data.number };
    switch (event.type) {
      case 'pr.opened':
        Object.assign(patch, {
          prUrl: event.data.url,
          prState: 'open',
          prChecks: event.data.checks,
          prMergeable: event.data.mergeable ?? null,
        });
        break;
      case 'pr.checks_changed':
        patch.prChecks = event.data.checks;
        if (event.data.mergeable !== undefined) {
          patch.prMergeable = event.data.mergeable;
        }
        break;
      case 'pr.closed':
        patch.prState = event.data.merged ? 'merged' : 'closed';
        break;
    }
    return this.update(row, applied, patch);
  }

  private covering(name: string, ts: Date): Promise<Slot | null> {
    return this.tx.slot.findFirst({
      where: { projectId: this.project.id, name, startedAt: { lte: ts } },
      orderBy: { startedAt: 'desc' },
    });
  }

  /** `parseFleetEvent` guarantees the envelope slot of slot-scoped events. */
  private slotName(event: SlotEvent): string {
    if (!event.slot) throw new Error(`${event.type} without a slot`);
    return event.slot;
  }

  private async create(
    applied: Applied<SlotEvent>,
    patch: SlotPatch,
  ): Promise<void> {
    const name = this.slotName(applied.event);
    const fields = {
      sessionAlive: null,
      pane: null,
      worktreeExists: true,
      prState: null,
      ...patch,
      ...(applied.event.issue ? { issue: applied.event.issue } : {}),
    };
    const status = deriveSlotStatus(fields);
    const row = await this.tx.slot.create({
      data: {
        projectId: this.project.id,
        name,
        worktree: worktreePath(this.project.rootPath, name),
        owns: [],
        never: [],
        ...fields,
        status,
        endedAt: status === 'ended' ? applied.ts : null,
        lastSeq: applied.seq,
        startedAt: applied.ts,
        updatedAt: applied.ts,
      },
      select: { id: true },
    });
    this.changed({ kind: 'slot', id: row.id });
  }

  private async update(
    row: Slot,
    applied: Applied<SlotEvent>,
    patch: SlotPatch,
  ): Promise<void> {
    const fields = {
      ...patch,
      ...(applied.event.issue ? { issue: applied.event.issue } : {}),
    };
    const status = deriveSlotStatus({
      sessionAlive:
        fields.sessionAlive !== undefined
          ? fields.sessionAlive
          : row.sessionAlive,
      pane: fields.pane !== undefined ? fields.pane : row.pane,
      worktreeExists: fields.worktreeExists ?? row.worktreeExists,
      prState: fields.prState ?? row.prState,
    });
    const endedAt =
      status !== 'ended'
        ? null
        : row.status === 'ended'
          ? row.endedAt
          : applied.ts;
    await this.tx.slot.update({
      where: { id: row.id },
      data: {
        ...fields,
        status,
        endedAt,
        lastSeq: applied.seq,
        updatedAt: applied.ts,
      },
    });
    this.changed({ kind: 'slot', id: row.id });
  }
}

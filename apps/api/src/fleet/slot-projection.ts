import type { PaneState, PrState } from '@agentdock/shared';
import type {
  CheckpointKind,
  PrChecks,
  SlotRuntime,
} from '@agentdock/shared/protocol';
import { Prisma, type Slot } from '@prisma/client';
import {
  guardGroups,
  readSources,
  type SlotGroup,
  type SlotSources,
} from './field-sources';
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
export interface SlotPatch {
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

/** Spec 16 D7: the columns of each field group the plugin reports. */
const SLOT_GROUPS = {
  model: ['model', 'modelWhy', 'owns', 'never', 'lead'],
  checkpoint: ['lastCheckpoint'],
  pr: ['prNumber', 'prUrl', 'prState', 'prChecks', 'prMergeable'],
} as const satisfies Record<string, readonly (keyof SlotPatch)[]>;

export type SlotEvent = EventOf<
  | 'session.appeared'
  | 'session.vanished'
  | 'pane.prompt'
  | 'pane.idle'
  | 'pane.quota_hit'
  | 'pane.busy'
  | 'worktree.changed'
  | 'slot.dispatched'
  | 'slot.redispatched'
  | 'slot.checkpoint'
  | 'pr.opened'
  | 'pr.checks_changed'
  | 'pr.closed'
  | 'pr.merged'
>;

/** What a run is written from: a slot event, or a slot of a snapshot (D6). */
type Source = Pick<Applied, 'ts' | 'seq'> & {
  source: Applied['event']['source'];
  issue?: number;
};

const sourceOf = (applied: Applied): Source => ({
  ts: applied.ts,
  seq: applied.seq,
  source: applied.event.source,
  issue: applied.event.issue,
});

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
 * a session appearing or a dispatch can start a run. An event at or below the
 * run's `lastSeq` was applied already, so a replay changes nothing. A field
 * group last written by Code Sentinel is never overwritten from markdown
 * (spec 16 D7).
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
        return event.data.round === undefined || event.data.date === undefined
          ? this.pluginDispatched(applied as Applied<typeof event>)
          : this.dispatched(applied as Applied<typeof event>);
      case 'slot.checkpoint':
        return this.checkpoint(applied as Applied<typeof event>);
      case 'pr.opened':
      case 'pr.checks_changed':
      case 'pr.closed':
      case 'pr.merged':
        return this.pullRequest(applied as Applied<typeof event>);
      default: {
        const row = await this.covering(this.slotName(event), applied.ts);
        if (!row || applied.seq <= row.lastSeq) return;
        return this.update(row, sourceOf(applied), this.patchOf(event));
      }
    }
  }

  private patchOf(
    event: EventOf<
      | 'session.vanished'
      | 'pane.prompt'
      | 'pane.idle'
      | 'pane.quota_hit'
      | 'pane.busy'
      | 'worktree.changed'
      | 'slot.redispatched'
    >,
  ): SlotPatch {
    switch (event.type) {
      case 'session.vanished':
        return { sessionAlive: false, pane: null };
      case 'slot.redispatched':
        return { model: event.data.toModel };
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
    const name = this.slotName(applied.event);
    const row = await this.covering(name, applied.ts);
    if (row && applied.seq <= row.lastSeq) return;
    if (!row || row.status === 'ended') {
      return this.create(name, sourceOf(applied), patch);
    }
    return this.update(row, sourceOf(applied), patch);
  }

  private dispatchPatch(data: EventOf<'slot.dispatched'>['data']): SlotPatch {
    return {
      ...(data.date && data.round
        ? { round: `${data.date}/${data.round}` }
        : {}),
      runtime: data.runtime,
      model: data.model ?? null,
      modelWhy: data.modelWhy ?? null,
      owns: data.owns,
      never: data.never,
      lead: data.lead ?? null,
      ...(data.branch ? { branch: data.branch } : {}),
      ...(data.worktree ? { worktree: data.worktree } : {}),
    };
  }

  /**
   * A brief starts a run unless one already carries its round, or the covering
   * run has no brief yet (its session appeared first, or only the plugin
   * reported it) or is still waiting for its session (the brief was rewritten
   * before launch).
   */
  private async dispatched(
    applied: Applied<EventOf<'slot.dispatched'>>,
  ): Promise<void> {
    const { event } = applied;
    const patch = this.dispatchPatch(event.data);
    const name = this.slotName(event);
    const round = `${event.data.date}/${event.data.round}`;
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
    if (newRun) return this.create(name, sourceOf(applied), patch);
    return this.update(row, sourceOf(applied), patch);
  }

  /**
   * `dispatch.sh`'s launch record names no round (spec 16 Q3). It belongs to
   * the covering run unless that run ended or an earlier plugin dispatch
   * already started it; a dispatch older than a known later run is history
   * and changes nothing.
   */
  private async pluginDispatched(
    applied: Applied<EventOf<'slot.dispatched'>>,
  ): Promise<void> {
    const name = this.slotName(applied.event);
    const dispatchedAt = applied.ts.toISOString();
    return this.upsertRun(name, sourceOf(applied), dispatchedAt, {
      patch: this.dispatchPatch(applied.event.data),
    });
  }

  /**
   * Writes a run reported by Code Sentinel — a plugin dispatch, or a slot of
   * `state.json` — started at `dispatchedAt` (spec 16 Q3, D6). `create: false`
   * only updates a run that exists.
   */
  async upsertRun(
    name: string,
    source: Source,
    dispatchedAt: string | null,
    options: { patch: SlotPatch; create?: boolean },
  ): Promise<void> {
    const { patch } = options;
    const row = await this.covering(name, source.ts);
    if (row && source.seq <= row.lastSeq) return;
    const prior = row
      ? readSources<SlotSources>(row.sources).dispatchedAt
      : undefined;
    const startedAt = dispatchedAt ? new Date(dispatchedAt) : source.ts;
    const extra: SlotSources = dispatchedAt ? { dispatchedAt } : {};
    const sameRun =
      row !== null &&
      row.status !== 'ended' &&
      (!prior || !dispatchedAt || prior >= dispatchedAt);
    if (sameRun) return this.update(row, source, patch, extra);
    if (options.create === false) return;
    const later = await this.tx.slot.findFirst({
      where: { projectId: this.project.id, name, startedAt: { gt: startedAt } },
      select: { id: true },
    });
    if (later) return;
    return this.create(name, source, patch, { startedAt, extra });
  }

  private async checkpoint(
    applied: Applied<EventOf<'slot.checkpoint'>>,
  ): Promise<void> {
    const { event } = applied;
    const row = await this.covering(this.slotName(event), applied.ts);
    if (!row || applied.seq <= row.lastSeq) return;
    const { data } = event;
    const sources = readSources<SlotSources>(row.sources);
    const extra: SlotSources = {};
    let position = data.position;
    if (position === undefined && event.source === 'code-sentinel') {
      position = await this.pluginPosition(row, data.checkpoint, sources);
      extra.checkpoints = position + 1;
    } else if (position === undefined) {
      position = (await this.maxPosition(row.id)) + 1;
    }
    const existing = await this.tx.slotCheckpoint.findUnique({
      where: { slotId_position: { slotId: row.id, position } },
      select: { id: true },
    });
    // Markdown never rewrites a checkpoint the plugin reported (D7); it may
    // still add a heading the plugin has not sent.
    const frozen =
      event.source === 'scraped' && sources.checkpoint === 'code-sentinel';
    if (!existing) {
      await this.tx.slotCheckpoint.create({
        data: {
          slotId: row.id,
          position,
          at: applied.ts,
          kind: data.checkpoint,
          heading: data.heading ?? data.checkpoint,
          summary: data.summary,
        },
      });
    } else if (!frozen) {
      await this.tx.slotCheckpoint.update({
        where: { id: existing.id },
        data: {
          kind: data.checkpoint,
          ...(data.heading ? { heading: data.heading } : {}),
          summary: data.summary,
        },
      });
    }
    const last = await this.tx.slotCheckpoint.findFirstOrThrow({
      where: { slotId: row.id },
      orderBy: { position: 'desc' },
      select: { kind: true },
    });
    return this.update(
      row,
      sourceOf(applied),
      {
        lastCheckpoint: last.kind,
        ...(data.prUrl ? { prUrl: data.prUrl } : {}),
        ...(data.prNumber ? { prNumber: data.prNumber } : {}),
      },
      extra,
    );
  }

  /**
   * A plugin checkpoint has no position. The worker writes the reply heading
   * first and the event right after, so the k-th plugin checkpoint is the
   * first heading of its kind from the last one it claimed on — the row the
   * reply collector made for it, if it came first. Else it is appended.
   */
  private async pluginPosition(
    row: Slot,
    kind: CheckpointKind,
    sources: SlotSources,
  ): Promise<number> {
    const from = sources.checkpoints ?? 0;
    const match = await this.tx.slotCheckpoint.findFirst({
      where: { slotId: row.id, kind, position: { gte: from } },
      orderBy: { position: 'asc' },
      select: { position: true },
    });
    if (match) return match.position;
    return Math.max(from, (await this.maxPosition(row.id)) + 1);
  }

  private async maxPosition(slotId: string): Promise<number> {
    const { _max } = await this.tx.slotCheckpoint.aggregate({
      where: { slotId },
      _max: { position: true },
    });
    return _max.position ?? -1;
  }

  /**
   * A PR belongs to the event's slot, else to the latest run with its number
   * (`pr.merged` has no branch), else to the latest run on its branch.
   */
  private async pullRequest(
    applied: Applied<
      EventOf<'pr.opened' | 'pr.checks_changed' | 'pr.closed' | 'pr.merged'>
    >,
  ): Promise<void> {
    const { event } = applied;
    const { data } = event;
    const latest = (where: Prisma.SlotWhereInput) =>
      this.tx.slot.findFirst({
        where: { projectId: this.project.id, ...where },
        orderBy: { startedAt: 'desc' },
      });
    const row = event.slot
      ? await this.covering(event.slot, applied.ts)
      : ((event.type === 'pr.merged'
          ? await latest({ prNumber: data.number })
          : null) ??
        (data.branch ? await latest({ branch: data.branch }) : null));
    if (!row || applied.seq <= row.lastSeq) return;
    const patch: SlotPatch = { prNumber: data.number };
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
        // Without `merged` the writer only saw it leave the open list.
        if (event.data.merged !== undefined) {
          patch.prState = event.data.merged ? 'merged' : 'closed';
        }
        break;
      case 'pr.merged':
        patch.prState = 'merged';
        break;
    }
    return this.update(row, sourceOf(applied), patch);
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
    name: string,
    source: Source,
    patch: SlotPatch,
    options: { startedAt?: Date; extra?: SlotSources } = {},
  ): Promise<void> {
    const guarded = guardGroups(SLOT_GROUPS, {}, source.source, patch);
    const fields = {
      sessionAlive: null,
      pane: null,
      worktreeExists: true,
      prState: null,
      ...guarded.patch,
      ...(source.issue ? { issue: source.issue } : {}),
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
        sources: {
          ...guarded.sources,
          ...options.extra,
        } as Prisma.InputJsonObject,
        status,
        endedAt: status === 'ended' ? source.ts : null,
        lastSeq: source.seq,
        startedAt: options.startedAt ?? source.ts,
        updatedAt: source.ts,
      },
      select: { id: true },
    });
    this.changed({ kind: 'slot', id: row.id });
  }

  private async update(
    row: Slot,
    source: Source,
    patch: SlotPatch,
    extra: SlotSources = {},
  ): Promise<void> {
    const current = readSources<SlotSources>(row.sources);
    const guarded = guardGroups<SlotGroup, SlotPatch>(
      SLOT_GROUPS,
      current,
      source.source,
      patch,
    );
    const fields = {
      ...guarded.patch,
      ...(source.issue ? { issue: source.issue } : {}),
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
          : source.ts;
    await this.tx.slot.update({
      where: { id: row.id },
      data: {
        ...fields,
        sources: {
          ...current,
          ...guarded.sources,
          ...extra,
        } as Prisma.InputJsonObject,
        status,
        endedAt,
        lastSeq: source.seq,
        updatedAt: source.ts,
      },
    });
    this.changed({ kind: 'slot', id: row.id });
  }
}

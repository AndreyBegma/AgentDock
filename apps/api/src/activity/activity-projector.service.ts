import {
  ACTIVITY_AUDIT_ACTIONS,
  ACTIVITY_EVENT_TYPES,
  ACTIVITY_ITEM_LIVE_EVENT,
  type ActivityDraft,
  activityFromAudit,
  activityFromEvent,
  SCRAPED_SHADOWED_EVENT_TYPES,
} from '@agentdock/shared';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { LiveService } from '../live/live.service';
import { toActivityItems } from './activity-mapper';
import { ACTIVITY_OPTIONS, type ActivityOptions } from './activity-options';
import { EventFrontier } from './event-frontier';

/** Source rows considered per transaction (spec 21 risks: batch 1 000). */
export const ACTIVITY_BATCH = 1000;
/** Batches one tick runs at most, so a backlog never starves the event loop. */
const MAX_BATCHES_PER_TICK = 50;
const STATE_ID = 'activity';
/** The plugin channel is live when it sent an event in this window (spec 16 D8). */
const PLUGIN_CHANNEL_WINDOW_MS = 24 * 60 * 60 * 1000;
const TRANSACTION_TIMEOUT_MS = 60_000;

type Tx = Prisma.TransactionClient;
type NewItem = Prisma.ActivityItemCreateManyInput;

interface ProjectRow {
  id: string;
  runnerId: string;
  rootPath: string;
  repo: string;
}

/** What one batch did: how many source rows it passed, and the items it created. */
interface BatchResult {
  advanced: boolean;
  full: boolean;
  created: Prisma.ActivityItemGetPayload<object>[];
}

/**
 * Projects curated runner events and audit records into `activity_items`
 * (spec 21 D1–D5). It tails `events` by `id` and `audit_records` by `seq` and
 * keeps both cursors in `activity_projector_state`, written in the same
 * transaction as the items; it never hooks into #6's ingest, #8's
 * `AuditService` or #11's projector. Replaying a row is a no-op through the
 * unique `(sourceKind, sourceId)`, and only fresh items are pushed live (D9).
 */
@Injectable()
export class ActivityProjector
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(ActivityProjector.name);
  private readonly frontier: EventFrontier;
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<number> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly live: LiveService,
    @Inject(ACTIVITY_OPTIONS) private readonly options: ActivityOptions,
  ) {
    this.frontier = new EventFrontier(options.gapGraceMs);
  }

  onApplicationBootstrap(): void {
    if (!this.options.loop) return;
    this.timer = setInterval(() => {
      void this.tick().catch((error: unknown) =>
        this.logger.error(
          `activity projection failed: ${(error as Error).message}`,
        ),
      );
    }, this.options.pollMs);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * Projects everything new since the stored cursors; returns how many items
   * it created. Calls overlap into the one in flight.
   */
  tick(): Promise<number> {
    this.inFlight ??= this.drain().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async drain(): Promise<number> {
    let created = 0;
    for (const step of [
      () => this.eventsBatch(),
      () => this.auditBatch(),
    ] as const) {
      for (let i = 0; i < MAX_BATCHES_PER_TICK; i += 1) {
        const batch = await step();
        created += batch.created.length;
        await this.publish(batch.created);
        if (!batch.advanced || !batch.full) break;
      }
    }
    return created;
  }

  private transaction<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`
          INSERT INTO activity_projector_state (id, "updatedAt")
          VALUES (${STATE_ID}, now()) ON CONFLICT (id) DO NOTHING`;
        return work(tx);
      },
      { timeout: TRANSACTION_TIMEOUT_MS },
    );
  }

  /** The state row, locked: a second API instance waits for this batch. */
  private async lockedState(
    tx: Tx,
  ): Promise<{ eventsCursor: bigint; auditCursor: bigint }> {
    const [state] = await tx.$queryRaw<
      { eventsCursor: bigint; auditCursor: bigint }[]
    >`
      SELECT "eventsCursor", "auditCursor" FROM activity_projector_state
      WHERE id = ${STATE_ID} FOR UPDATE`;
    return state;
  }

  private eventsBatch(): Promise<BatchResult> {
    return this.transaction(async (tx) => {
      const { eventsCursor: cursor } = await this.lockedState(tx);
      const ids = await tx.$queryRaw<{ id: bigint }[]>`
        SELECT id FROM events WHERE id > ${cursor} ORDER BY id LIMIT ${ACTIVITY_BATCH}`;
      const frontier = this.frontier.advance(
        cursor,
        ids.map((r) => r.id),
        Date.now(),
      );
      const full = ids.length === ACTIVITY_BATCH;
      if (frontier === cursor) return { advanced: false, full, created: [] };

      const rows = await tx.event.findMany({
        where: {
          id: { gt: cursor, lte: frontier },
          type: { in: [...ACTIVITY_EVENT_TYPES] },
        },
        orderBy: { id: 'asc' },
      });
      const projects = await this.projectsOf(
        tx,
        rows.map((r) => r.runnerId),
      );
      const items: NewItem[] = [];
      for (const row of rows) {
        // D4: an event naming a project nobody connected produces no item;
        // one naming none (runner-level) is project-less.
        const projectId = resolveProject(projects, row);
        const named = row.projectRoot !== null || row.projectRepo !== null;
        if (!projectId && named) continue;
        if (await this.shadowedByPlugin(tx, row)) continue;
        const draft = activityFromEvent(row, projectId);
        if (draft)
          items.push(newItem(draft, row.ts, projectId, 'event', row.id));
      }
      const created = await this.insert(tx, items);
      await tx.activityProjectorState.update({
        where: { id: STATE_ID },
        data: { eventsCursor: frontier },
      });
      return { advanced: true, full, created };
    });
  }

  private auditBatch(): Promise<BatchResult> {
    return this.transaction(async (tx) => {
      const { auditCursor: cursor } = await this.lockedState(tx);
      // #8 serializes audit inserts under an advisory lock, so `seq` commits
      // in order and a plain cursor misses nothing.
      const [{ upTo }] = await tx.$queryRaw<{ upTo: bigint | null }[]>`
        SELECT max(seq) AS "upTo" FROM (
          SELECT seq FROM audit_records WHERE seq > ${cursor}
          ORDER BY seq LIMIT ${ACTIVITY_BATCH}
        ) page`;
      if (upTo === null) return { advanced: false, full: false, created: [] };

      const rows = await tx.auditRecord.findMany({
        where: {
          seq: { gt: cursor, lte: upTo },
          action: { in: [...ACTIVITY_AUDIT_ACTIONS] },
        },
        orderBy: { seq: 'asc' },
      });
      const projectIds = [
        ...new Set(rows.map((r) => r.projectId).filter((id) => id !== null)),
      ];
      const existing = new Set(
        projectIds.length === 0
          ? []
          : (
              await tx.project.findMany({
                where: { id: { in: projectIds } },
                select: { id: true },
              })
            ).map((p) => p.id),
      );
      const items: NewItem[] = [];
      for (const row of rows) {
        // A record of a deleted project is admin-only now (D4).
        const projectId =
          row.projectId && existing.has(row.projectId) ? row.projectId : null;
        const draft = activityFromAudit(row, projectId);
        if (draft) {
          items.push(newItem(draft, row.ts, projectId, 'audit', row.seq));
        }
      }
      const created = await this.insert(tx, items);
      await tx.activityProjectorState.update({
        where: { id: STATE_ID },
        data: { auditCursor: upTo },
      });
      return {
        advanced: true,
        full: upTo - cursor >= BigInt(ACTIVITY_BATCH),
        created,
      };
    });
  }

  private insert(tx: Tx, items: NewItem[]) {
    if (items.length === 0) return Promise.resolve([]);
    return tx.activityItem.createManyAndReturn({
      data: items,
      skipDuplicates: true,
    });
  }

  private async projectsOf(tx: Tx, runnerIds: string[]): Promise<ProjectRow[]> {
    const ids = [...new Set(runnerIds)];
    if (ids.length === 0) return [];
    return tx.project.findMany({
      where: { runnerId: { in: ids } },
      select: { id: true, runnerId: true, rootPath: true, repo: true },
    });
  }

  /**
   * A `scraped` copy of a fact Code Sentinel also reports, while the
   * project's plugin channel is live (spec 16 D8) — the plugin's own event is
   * the item. Judged on events received before it, so a replay agrees.
   */
  private async shadowedByPlugin(
    tx: Tx,
    row: {
      runnerId: string;
      source: string;
      type: string;
      projectRoot: string | null;
      receivedAt: Date;
    },
  ): Promise<boolean> {
    if (row.source !== 'scraped' || row.projectRoot === null) return false;
    if (!SCRAPED_SHADOWED_EVENT_TYPES.has(row.type)) return false;
    const since = new Date(row.receivedAt.getTime() - PLUGIN_CHANNEL_WINDOW_MS);
    const [{ live }] = await tx.$queryRaw<{ live: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM events
        WHERE "projectRoot" = ${row.projectRoot} AND source = 'code-sentinel'
          AND "runnerId" = ${row.runnerId}
          AND "receivedAt" > ${since} AND "receivedAt" <= ${row.receivedAt}
      ) AS live`;
    return live;
  }

  /** Pushes fresh items on `project:<id>`, or `admin` for project-less ones (D9). */
  private async publish(
    created: Prisma.ActivityItemGetPayload<object>[],
  ): Promise<void> {
    if (created.length === 0) return;
    for (const item of await toActivityItems(this.prisma, created)) {
      try {
        this.live.publish(
          item.projectId ? `project:${item.projectId}` : 'admin',
          ACTIVITY_ITEM_LIVE_EVENT,
          item,
        );
      } catch (error) {
        this.logger.warn(
          `activity item ${item.id} not pushed: ${(error as Error).message}`,
        );
      }
    }
  }
}

/**
 * D4: an event's project by `(runnerId, projectRoot)` — unique per runner —
 * else by `projectRepo` when exactly one project of the runner has it. null:
 * the event names no project (runner-level), or none matches.
 */
export const resolveProject = (
  projects: readonly ProjectRow[],
  event: {
    runnerId: string;
    projectRoot: string | null;
    projectRepo: string | null;
  },
): string | null => {
  const own = projects.filter((p) => p.runnerId === event.runnerId);
  if (event.projectRoot !== null) {
    return own.find((p) => p.rootPath === event.projectRoot)?.id ?? null;
  }
  if (event.projectRepo !== null) {
    const byRepo = own.filter((p) => p.repo === event.projectRepo);
    return byRepo.length === 1 ? byRepo[0].id : null;
  }
  return null;
};

const newItem = (
  draft: ActivityDraft,
  ts: Date,
  projectId: string | null,
  sourceKind: 'event' | 'audit',
  sourceId: bigint,
): NewItem => ({
  ...draft,
  ts,
  projectId,
  data: draft.data as Prisma.InputJsonObject,
  sourceKind,
  sourceId,
});

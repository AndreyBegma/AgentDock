import {
  buildWebhookEnvelope,
  isWebhookEventType,
  SCRAPED_SHADOWED_EVENT_TYPES,
  WEBHOOK_DISPATCH_INTERVAL_MS,
  type WebhookEventType,
  webhookEnvelopeId,
} from '@agentdock/shared';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { EventFrontier } from '../../activity/event-frontier';
import { PrismaService } from '../../database/prisma.service';
import { WEBHOOKS_OPTIONS, type WebhooksOptions } from '../common';

type Tx = Prisma.TransactionClient;

const STATE_ID = 'webhooks';
const LOCK_KEY = 'webhooks:dispatcher';
/** Events read per pass. */
const DISPATCH_BATCH = 500;
/** How long a hole in `events.id` is waited on (as the activity projector). */
const HOLE_GRACE_MS = 10_000;
/** The plugin channel is live when it sent an event in this window (spec 16 D8). */
const PLUGIN_CHANNEL_WINDOW_MS = 24 * 60 * 60 * 1000;
const TRANSACTION_TIMEOUT_MS = 60_000;

const EVENT_SELECT = {
  id: true,
  runnerId: true,
  ts: true,
  type: true,
  source: true,
  projectRepo: true,
  projectRoot: true,
  slot: true,
  issue: true,
  data: true,
  receivedAt: true,
} as const;

type EventRow = Prisma.EventGetPayload<{ select: typeof EVENT_SELECT }>;

interface Target {
  id: string;
  events: string[];
  projectIds: string[];
}

interface ProjectRow {
  id: string;
  runnerId: string;
  rootPath: string;
  repo: string;
}

/**
 * The outbound dispatcher (docs/specs/26-webhooks.md D11). A cursor over
 * `events.id` in `webhook_dispatcher_state`, advanced in the same transaction
 * as the deliveries it inserts; for every event in the D9 catalogue it writes
 * one `webhook_deliveries` row per matching enabled webhook, carrying the D10
 * envelope. Replaying an event is a no-op through the unique
 * `(webhookId, eventId)`. It reads `events` only and never touches #6's ingest.
 *
 * `events.id` is a sequence whose inserts can commit out of order, so the
 * cursor moves through `EventFrontier` (spec 21 notes). A scraped event that a
 * live plugin channel shadows is skipped, as the activity feed skips it, so
 * one checkpoint is one delivery. `webhook.test` is the API's own type: a
 * runner event of that name is never forwarded.
 */
@Injectable()
export class WebhookDispatcher
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(WebhookDispatcher.name);
  private readonly frontier = new EventFrontier(HOLE_GRACE_MS);
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(WEBHOOKS_OPTIONS) private readonly options: WebhooksOptions,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.options.workerEnabled) return;
    this.timer = setInterval(() => {
      void this.tick().catch((error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error);
        this.logger.error(`webhook dispatcher failed: ${reason}`);
      });
    }, WEBHOOK_DISPATCH_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  /**
   * One pass. Returns how many deliveries it created; `null` when another
   * pass (here or on another instance) holds the lock.
   */
  async tick(now = Date.now()): Promise<number | null> {
    if (this.running) return null;
    this.running = true;
    try {
      return await this.prisma.$transaction((tx) => this.pass(tx, now), {
        timeout: TRANSACTION_TIMEOUT_MS,
      });
    } finally {
      this.running = false;
    }
  }

  private async pass(tx: Tx, now: number): Promise<number | null> {
    const [{ locked }] = await tx.$queryRaw<{ locked: boolean }[]>`
      SELECT pg_try_advisory_xact_lock(hashtext(${LOCK_KEY})) AS locked`;
    if (!locked) return null;

    const state = await tx.webhookDispatcherState.findUnique({
      where: { id: STATE_ID },
    });
    if (!state) {
      // First start: what happened before webhooks existed is not sent. The
      // sequence, not `max(id)`: ids in flight would otherwise read as a hole.
      const [{ last }] = await tx.$queryRaw<{ last: bigint | null }[]>`
        SELECT pg_sequence_last_value(pg_get_serial_sequence('events', 'id')::regclass) AS last`;
      await tx.webhookDispatcherState.create({
        data: { id: STATE_ID, eventsCursor: last ?? 0n },
      });
      return 0;
    }

    const events = await tx.event.findMany({
      where: { id: { gt: state.eventsCursor } },
      orderBy: { id: 'asc' },
      take: DISPATCH_BATCH,
      select: EVENT_SELECT,
    });
    const cursor = this.frontier.advance(
      state.eventsCursor,
      events.map((event) => event.id),
      now,
    );
    if (cursor === state.eventsCursor) return 0;

    const passed = events.filter(
      (event) =>
        event.id <= cursor &&
        event.type !== 'webhook.test' &&
        isWebhookEventType(event.type),
    );
    const created = passed.length > 0 ? await this.dispatch(tx, passed) : 0;
    await tx.webhookDispatcherState.update({
      where: { id: STATE_ID },
      data: { eventsCursor: cursor },
    });
    return created;
  }

  private async dispatch(tx: Tx, events: EventRow[]): Promise<number> {
    const targets: Target[] = await tx.webhook.findMany({
      where: { enabled: true },
      select: { id: true, events: true, projectIds: true },
    });
    if (targets.length === 0) return 0;
    const projects = await this.projects(tx, events);

    const rows: Prisma.WebhookDeliveryCreateManyInput[] = [];
    for (const event of events) {
      const type = event.type as WebhookEventType;
      const matching = targets.filter((target) => target.events.includes(type));
      if (matching.length === 0) continue;
      if (await this.shadowed(tx, event)) continue;
      const project = resolveProject(event, projects);
      const envelope = buildWebhookEnvelope({
        id: webhookEnvelopeId(event.id),
        type,
        ts: event.ts,
        project: project ? { id: project.id, repo: project.repo } : null,
        slot: event.slot,
        issue: event.issue,
        data: event.data,
      });
      if (!envelope) continue;
      for (const target of matching) {
        if (!projectMatches(target, project?.id ?? null)) continue;
        rows.push({
          webhookId: target.id,
          eventId: event.id,
          eventType: type,
          payload: envelope as unknown as Prisma.InputJsonObject,
        });
      }
    }
    if (rows.length === 0) return 0;
    const { count } = await tx.webhookDelivery.createMany({
      data: rows,
      skipDuplicates: true,
    });
    return count;
  }

  /** The projects of every runner in the batch, for `resolveProject`. */
  private projects(tx: Tx, events: EventRow[]): Promise<ProjectRow[]> {
    const runnerIds = [...new Set(events.map((event) => event.runnerId))];
    return tx.project.findMany({
      where: { runnerId: { in: runnerIds } },
      select: { id: true, runnerId: true, rootPath: true, repo: true },
    });
  }

  /**
   * A scraped checkpoint or dispatch while the project's plugin channel is
   * live duplicates the plugin's own event (spec 16 D8): skipped.
   */
  private async shadowed(tx: Tx, event: EventRow): Promise<boolean> {
    if (event.source !== 'scraped' || event.projectRoot === null) return false;
    if (!SCRAPED_SHADOWED_EVENT_TYPES.has(event.type)) return false;
    const since = new Date(
      event.receivedAt.getTime() - PLUGIN_CHANNEL_WINDOW_MS,
    );
    const [{ live }] = await tx.$queryRaw<{ live: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM events
        WHERE "projectRoot" = ${event.projectRoot} AND source = 'code-sentinel'
          AND "runnerId" = ${event.runnerId}
          AND "receivedAt" > ${since} AND "receivedAt" <= ${event.receivedAt}
      ) AS live`;
    return live;
  }
}

/**
 * Event → project: `(runnerId, rootPath)` first; `repo` only when exactly one
 * project of the runner has it (it is not unique per runner).
 */
export const resolveProject = (
  event: Pick<EventRow, 'runnerId' | 'projectRoot' | 'projectRepo'>,
  projects: readonly ProjectRow[],
): ProjectRow | null => {
  const own = projects.filter((p) => p.runnerId === event.runnerId);
  if (event.projectRoot) {
    const byRoot = own.find((p) => p.rootPath === event.projectRoot);
    if (byRoot) return byRoot;
  }
  if (!event.projectRepo) return null;
  const byRepo = own.filter((p) => p.repo === event.projectRepo);
  return byRepo.length === 1 ? byRepo[0] : null;
};

/** D11: `projectIds` empty is every project — and the events of none. */
export const projectMatches = (
  target: Pick<Target, 'projectIds'>,
  projectId: string | null,
): boolean =>
  target.projectIds.length === 0 ||
  (projectId !== null && target.projectIds.includes(projectId));

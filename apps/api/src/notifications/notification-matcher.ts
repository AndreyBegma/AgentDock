import { QUEUE_DRY_INTERVAL_MS } from '@agentdock/shared';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import {
  draftFor,
  type MatchableEvent,
  type NotificationDraft,
  projectLink,
} from './event-mapping';
import {
  NOTIFICATION_OPTIONS,
  type NotificationOptions,
} from './notification-options';
import {
  NotificationWriter,
  type WrittenNotification,
} from './notification-writer';
import { NotificationsService } from './notifications.service';

type Tx = Prisma.TransactionClient;

const STATE_ID = 1;
const LOCK_KEY = 'notifications:matcher';
const TRANSACTION_TIMEOUT_MS = 60_000;

/** The `events` columns the matcher reads. */
const EVENT_SELECT = {
  id: true,
  runnerId: true,
  seq: true,
  ts: true,
  type: true,
  source: true,
  projectRepo: true,
  projectRoot: true,
  slot: true,
  issue: true,
  data: true,
} as const;

/**
 * Turns stored runner events into notifications (spec 22 D4). A cursor over
 * `events.id` in `notification_matcher_state`, advanced in the same
 * transaction as the rows it caused, so every event is matched once.
 *
 * `events.id` is a sequence, and two runners' inserts can commit out of id
 * order. The cursor therefore only moves over a contiguous run of ids: at a
 * hole it waits `holeWaitMs` for the missing id to commit, then takes it as a
 * rolled-back insert and moves on. A replay that does reach an event twice is
 * still harmless — `(eventId, userId, kind)` is unique.
 *
 * It never touches the ingest path or the fleet projector; a separate
 * advisory lock keeps it to one API instance at a time.
 */
@Injectable()
export class NotificationMatcher
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(NotificationMatcher.name);
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  /** The id the cursor waits for, and since when (ms). */
  private hole: { id: bigint; since: number } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly writer: NotificationWriter,
    private readonly notifications: NotificationsService,
    @Inject(NOTIFICATION_OPTIONS) private readonly options: NotificationOptions,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.options.autoStart) return;
    this.timer = setInterval(() => {
      void this.tick().catch((error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error);
        this.logger.error(`notification matcher failed: ${reason}`);
      });
    }, this.options.matcherIntervalMs);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  /**
   * One pass: matches up to a batch of events past the cursor. Returns how many
   * events it consumed; `null` when another pass (here or on another instance)
   * holds the lock.
   */
  async tick(now = Date.now()): Promise<number | null> {
    if (this.running) return null;
    this.running = true;
    try {
      const result = await this.prisma.$transaction(
        (tx) => this.pass(tx, now),
        { timeout: TRANSACTION_TIMEOUT_MS },
      );
      if (result === null) return null;
      await this.notifications.publish(result.written);
      return result.consumed;
    } finally {
      this.running = false;
    }
  }

  private async pass(
    tx: Tx,
    now: number,
  ): Promise<{ consumed: number; written: WrittenNotification[] } | null> {
    const [{ locked }] = await tx.$queryRaw<{ locked: boolean }[]>`
      SELECT pg_try_advisory_xact_lock(hashtext(${LOCK_KEY})) AS locked`;
    if (!locked) return null;

    const state = await tx.notificationMatcherState.findUnique({
      where: { id: STATE_ID },
    });
    if (!state) {
      // First start: nothing that happened before notifications existed is news.
      const { _max } = await tx.event.aggregate({ _max: { id: true } });
      await tx.notificationMatcherState.create({
        data: { id: STATE_ID, eventsCursor: _max.id ?? 0n },
      });
      return { consumed: 0, written: [] };
    }

    const events = await tx.event.findMany({
      where: { id: { gt: state.eventsCursor } },
      orderBy: { id: 'asc' },
      take: this.options.matcherBatch,
      select: EVENT_SELECT,
    });

    let cursor = state.eventsCursor;
    let consumed = 0;
    const written: WrittenNotification[] = [];
    const projects = new ProjectCache(tx);
    for (const event of events) {
      if (event.id !== cursor + 1n && !this.holeExpired(cursor + 1n, now)) {
        break;
      }
      this.hole = null;
      written.push(...(await this.match(tx, event, projects)));
      cursor = event.id;
      consumed += 1;
    }
    if (cursor !== state.eventsCursor) {
      await tx.notificationMatcherState.update({
        where: { id: STATE_ID },
        data: { eventsCursor: cursor },
      });
    }
    return { consumed, written };
  }

  /** Whether the missing `id` has been waited for long enough. */
  private holeExpired(id: bigint, now: number): boolean {
    if (this.hole?.id !== id) {
      this.hole = { id, since: now };
    }
    const expired = now - this.hole.since >= this.options.holeWaitMs;
    if (expired) {
      this.logger.warn(
        `events id ${id} never committed within ${this.options.holeWaitMs} ms; taken as rolled back`,
      );
    }
    return expired;
  }

  private async match(
    tx: Tx,
    event: MatchableEvent,
    projects: ProjectCache,
  ): Promise<WrittenNotification[]> {
    const draft = draftFor(event);
    if (!draft) return [];
    const projectId = await projects.resolve(event);
    if (!projectId) return [];
    if (
      draft.kind === 'queue.dry' &&
      !(await this.queueDry(tx, projectId, event.ts))
    ) {
      return [];
    }
    const recipients = await this.writer.projectRecipients(tx, projectId);
    return this.writer.write(
      tx,
      this.input(draft, event, projectId),
      recipients,
    );
  }

  private input(
    draft: NotificationDraft,
    event: MatchableEvent,
    projectId: string,
  ) {
    return {
      kind: draft.kind,
      projectId,
      runnerId: event.runnerId,
      slot: draft.slot,
      issue: draft.issue,
      title: draft.title,
      body: draft.body,
      link: projectLink(projectId, draft.page),
      eventId: event.id,
      at: event.ts,
      fold: true,
    };
  }

  /** D1: no slot still running, and no `queue.dry` for the project in 6 h. */
  private async queueDry(
    tx: Tx,
    projectId: string,
    at: Date,
  ): Promise<boolean> {
    const [live, recent] = await Promise.all([
      tx.slot.count({ where: { projectId, status: { not: 'ended' } } }),
      tx.notification.count({
        where: {
          kind: 'queue.dry',
          projectId,
          firstAt: { gt: new Date(at.getTime() - QUEUE_DRY_INTERVAL_MS) },
        },
      }),
    ]);
    return live === 0 && recent === 0;
  }
}

/**
 * Event → project, per pass. `(runnerId, projectRoot)` is unique on `projects`
 * and is tried first; `projectRepo` is not unique per runner, so it is a
 * fallback only when exactly one project of the runner has it.
 */
class ProjectCache {
  private readonly cache = new Map<string, string | null>();

  constructor(private readonly tx: Tx) {}

  async resolve(event: MatchableEvent): Promise<string | null> {
    const key = `${event.runnerId}\u0000${event.projectRoot ?? ''}\u0000${event.projectRepo ?? ''}`;
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;
    const id = await this.lookup(event);
    this.cache.set(key, id);
    return id;
  }

  private async lookup(event: MatchableEvent): Promise<string | null> {
    if (event.projectRoot) {
      const project = await this.tx.project.findUnique({
        where: {
          runnerId_rootPath: {
            runnerId: event.runnerId,
            rootPath: event.projectRoot,
          },
        },
        select: { id: true },
      });
      if (project) return project.id;
    }
    if (!event.projectRepo) return null;
    const byRepo = await this.tx.project.findMany({
      where: { runnerId: event.runnerId, repo: event.projectRepo },
      select: { id: true },
      take: 2,
    });
    return byRepo.length === 1 ? byRepo[0].id : null;
  }
}

import type { AuditAction, AuditResult } from '@nautelle/shared';
import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import type { AuditActor, AuditEntry } from './audit.types';
import {
  computeHash,
  GENESIS_HASH,
  type HashedFields,
  type JsonValue,
  redact,
} from './canonical';

/**
 * Orders appends across API processes (spec D2); the in-process queue below
 * keeps one process from parking a pool connection per waiting writer.
 */
const lockChain = (tx: Prisma.TransactionClient) =>
  tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('agentdock:audit'))`;

/** Generous: a burst of writers queues on the lock, each holding a transaction. */
const TX_OPTIONS = { maxWait: 15_000, timeout: 15_000 } as const;

const toDbJson = (value: JsonValue | null) =>
  value === null ? Prisma.DbNull : (value as Prisma.InputJsonValue);

export const FOLD_WINDOW_MS = 60_000;

const minuteOf = (at: Date) =>
  new Date(Math.floor(at.getTime() / FOLD_WINDOW_MS) * FOLD_WINDOW_MS);

interface FoldRow {
  action: string;
  targetType: string;
  targetId: string;
  ip: string;
  minute: Date;
  actor: AuditActor;
  result: AuditResult;
  userAgent: string | null;
  count: number;
  reasons: Record<string, number>;
}

/** Writes the append-only, hash-chained audit log (docs/specs/8). */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Appends one record. Never throws (spec D8): the action it describes has
   * already happened, so a failed write is logged at `error` and swallowed.
   */
  async record(entry: AuditEntry): Promise<void> {
    const run = this.tail.then(() => this.append(entry));
    this.tail = run.catch(() => undefined);
    try {
      await run;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.error(`audit ${entry.action} not recorded: ${reason}`);
    }
  }

  /**
   * Records `entry` folded with its repeats (C-109): the first of a minute
   * with the same action, target and IP is written at once with `count: 1`;
   * the rest are counted and written by `flushFolds` as one record with
   * `count` and a tally of `meta.reason`. Never throws, like `record`.
   */
  async recordFolded(entry: AuditEntry, now = new Date()): Promise<void> {
    const meta = (entry.meta ?? {}) as { reason?: unknown };
    const reason = typeof meta.reason === 'string' ? meta.reason : 'other';
    try {
      const [{ first }] = await this.prisma.$queryRaw<{ first: boolean }[]>`
        INSERT INTO audit_folds
          (action, "targetType", "targetId", ip, minute, actor, result, "userAgent")
        VALUES (
          ${entry.action}, ${entry.target.type}, ${entry.target.id ?? ''},
          ${entry.origin?.ip ?? ''}, ${minuteOf(now)},
          ${JSON.stringify(entry.actor)}::jsonb, ${entry.result}::"AuditResult",
          ${entry.origin?.userAgent?.slice(0, 512) ?? null}
        )
        ON CONFLICT (action, "targetType", "targetId", ip, minute) DO UPDATE SET
          count = audit_folds.count + 1,
          reasons = audit_folds.reasons || jsonb_build_object(
            ${reason}::text,
            COALESCE((audit_folds.reasons ->> ${reason}::text)::int, 0) + 1
          )
        RETURNING (xmax = 0) AS first`;
      if (!first) return;
    } catch (error) {
      // Without the fold, the record is written on its own rather than lost.
      const why = error instanceof Error ? error.message : String(error);
      this.logger.warn(`audit ${entry.action} not folded: ${why}`);
    }
    await this.record({ ...entry, meta: { ...entry.meta, count: 1 } });
  }

  /**
   * Writes the repeats of every minute that is over as one record each and
   * forgets them. The DELETE claims the rows, so two processes never write
   * the same repeats.
   */
  async flushFolds(now = new Date()): Promise<number> {
    const rows = await this.prisma.$queryRaw<FoldRow[]>`
      DELETE FROM audit_folds WHERE minute < ${minuteOf(now)} RETURNING *`;
    let written = 0;
    for (const row of rows) {
      if (row.count === 0) continue;
      await this.record({
        actor: row.actor,
        origin: {
          ip: row.ip || undefined,
          userAgent: row.userAgent ?? undefined,
        },
        action: row.action as AuditAction,
        target: { type: row.targetType, id: row.targetId || null },
        result: row.result,
        meta: {
          folded: true,
          count: row.count,
          reasons: row.reasons,
          minute: row.minute.toISOString(),
        },
      });
      written += 1;
    }
    return written;
  }

  /** One serialized append: lock, read the head, insert the linked row. */
  protected async append(entry: AuditEntry): Promise<void> {
    const { actor, origin } = entry;
    const meta =
      origin || entry.meta
        ? redact({
            ...entry.meta,
            ...(origin?.ip ? { ip: origin.ip } : {}),
            ...(origin?.userAgent
              ? { userAgent: origin.userAgent.slice(0, 512) }
              : {}),
          })
        : null;

    await this.prisma.$transaction(async (tx) => {
      await lockChain(tx);
      const head = await tx.auditRecord.findFirst({
        orderBy: { seq: 'desc' },
        select: { hash: true },
      });
      // Taken before the insert: the hash covers `seq`, and the trigger forbids
      // the UPDATE that filling it in afterwards would need.
      const [{ seq }] = await tx.$queryRaw<{ seq: bigint }[]>`
        SELECT nextval(pg_get_serial_sequence('audit_records', 'seq')) AS seq`;
      const prevHash = head?.hash ?? GENESIS_HASH;
      const row: HashedFields = {
        seq,
        // Millisecond precision, as `timestamp(3)` stores it.
        ts: new Date(),
        actorType: actor.type,
        actorUserId: actor.type === 'user' ? actor.userId : null,
        actorRunnerId: actor.type === 'runner' ? actor.runnerId : null,
        actorOnBehalfOfId:
          actor.type === 'system' ? (actor.onBehalfOf ?? null) : null,
        action: entry.action,
        targetType: entry.target.type,
        targetId: entry.target.id ?? null,
        projectId: entry.projectId ?? null,
        before: redact(entry.before),
        after: redact(entry.after),
        result: entry.result,
        meta,
      };
      await tx.auditRecord.create({
        data: {
          seq: row.seq,
          ts: row.ts,
          actorType: actor.type,
          actorUserId: row.actorUserId,
          actorRunnerId: row.actorRunnerId,
          actorOnBehalfOfId: row.actorOnBehalfOfId,
          action: row.action,
          targetType: row.targetType,
          targetId: row.targetId,
          projectId: row.projectId,
          before: toDbJson(row.before),
          after: toDbJson(row.after),
          result: entry.result,
          meta: toDbJson(row.meta),
          prevHash,
          hash: computeHash(prevHash, row),
        },
      });
    }, TX_OPTIONS);
  }
}

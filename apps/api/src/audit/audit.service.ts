import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import type { AuditEntry } from './audit.types';
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

import {
  AUDIT_ERROR,
  AUDIT_EXPORT_MAX_ROWS,
  AUDIT_PAGE_DEFAULT,
  type AuditErrorBody,
  type AuditFilters,
  type AuditPage,
  type AuditRecordView,
} from '@agentdock/shared';
import { HttpException, Injectable } from '@nestjs/common';
import type { AuditRecord, Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { csvRow } from './csv';

const EXPORT_BATCH = 1000;

const CSV_COLUMNS = [
  'seq',
  'ts',
  'actorType',
  'actorUserId',
  'actorRunnerId',
  'action',
  'targetType',
  'targetId',
  'projectId',
  'result',
  'before',
  'after',
  'meta',
  'prevHash',
  'hash',
] as const satisfies readonly (keyof AuditRecord)[];

export const auditNotFound = (): HttpException => {
  const body: AuditErrorBody = {
    statusCode: 404,
    error: AUDIT_ERROR.notFound,
    message: 'Audit record not found',
  };
  return new HttpException(body, 404);
};

const whereFor = (filters: AuditFilters): Prisma.AuditRecordWhereInput => ({
  ...(filters.from || filters.to
    ? {
        ts: {
          ...(filters.from ? { gte: new Date(filters.from) } : {}),
          ...(filters.to ? { lte: new Date(filters.to) } : {}),
        },
      }
    : {}),
  ...(filters.action ? { action: { startsWith: filters.action } } : {}),
  ...(filters.actorUserId ? { actorUserId: filters.actorUserId } : {}),
  ...(filters.targetType ? { targetType: filters.targetType } : {}),
  ...(filters.targetId ? { targetId: filters.targetId } : {}),
  ...(filters.projectId ? { projectId: filters.projectId } : {}),
  ...(filters.result ? { result: filters.result } : {}),
});

/** Reads the audit log for admins (spec "API"); it never writes. */
@Injectable()
export class AuditQueryService {
  constructor(private readonly prisma: PrismaService) {}

  /** Newest first; the cursor is the last `seq` of the previous page. */
  async list(
    filters: AuditFilters,
    cursor?: string,
    limit = AUDIT_PAGE_DEFAULT,
  ): Promise<AuditPage> {
    const rows = await this.prisma.auditRecord.findMany({
      where: {
        ...whereFor(filters),
        ...(cursor ? { seq: { lt: BigInt(cursor) } } : {}),
      },
      orderBy: { seq: 'desc' },
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    return {
      items: await this.toViews(page),
      nextCursor:
        rows.length > limit ? page[page.length - 1].seq.toString() : null,
    };
  }

  async get(seq: bigint): Promise<AuditRecordView> {
    const row = await this.prisma.auditRecord.findUnique({ where: { seq } });
    if (!row) throw auditNotFound();
    const [view] = await this.toViews([row]);
    return view;
  }

  /** CSV lines of the filtered set, newest first, at most 100 000 rows (D12). */
  async *exportCsv(filters: AuditFilters): AsyncGenerator<string> {
    yield csvRow(CSV_COLUMNS);
    const where = whereFor(filters);
    let before: bigint | undefined;
    let sent = 0;
    while (sent < AUDIT_EXPORT_MAX_ROWS) {
      const rows = await this.prisma.auditRecord.findMany({
        where: before === undefined ? where : { ...where, seq: { lt: before } },
        orderBy: { seq: 'desc' },
        take: Math.min(EXPORT_BATCH, AUDIT_EXPORT_MAX_ROWS - sent),
      });
      if (rows.length === 0) return;
      yield rows
        .map((row) =>
          csvRow(
            CSV_COLUMNS.map((column) =>
              column === 'ts' ? row.ts.toISOString() : row[column],
            ),
          ),
        )
        .join('');
      sent += rows.length;
      before = rows[rows.length - 1].seq;
    }
  }

  private async toViews(rows: AuditRecord[]): Promise<AuditRecordView[]> {
    const ids = [
      ...new Set(rows.flatMap((r) => (r.actorUserId ? [r.actorUserId] : []))),
    ];
    const users = ids.length
      ? await this.prisma.user.findMany({
          where: { id: { in: ids } },
          select: { id: true, email: true },
        })
      : [];
    const emails = new Map(users.map((u) => [u.id, u.email]));
    return rows.map((row) => ({
      seq: row.seq.toString(),
      ts: row.ts.toISOString(),
      actorType: row.actorType,
      actorUserId: row.actorUserId,
      actorEmail: row.actorUserId
        ? (emails.get(row.actorUserId) ?? null)
        : null,
      actorRunnerId: row.actorRunnerId,
      action: row.action,
      targetType: row.targetType,
      targetId: row.targetId,
      projectId: row.projectId,
      before: row.before,
      after: row.after,
      result: row.result,
      meta: row.meta,
      prevHash: row.prevHash,
      hash: row.hash,
    }));
  }
}

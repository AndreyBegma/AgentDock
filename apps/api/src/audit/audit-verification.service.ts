import {
  AUDIT_LAST_VERIFICATION_KEY,
  type AuditVerification,
} from '@agentdock/shared';
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { computeHash, GENESIS_HASH, type JsonValue } from './canonical';

const BATCH = 1000;

/** Walks the hash chain and reports the first break (spec D6). */
@Injectable()
export class AuditVerificationService {
  private readonly logger = new Logger(AuditVerificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
  ) {}

  /** Recomputes every hash in `seq` order; checks each link to its predecessor. */
  async verify(): Promise<AuditVerification> {
    let prevHash = GENESIS_HASH;
    let after: bigint | undefined;
    let checked = 0;
    for (;;) {
      const rows = await this.prisma.auditRecord.findMany({
        where: after === undefined ? {} : { seq: { gt: after } },
        orderBy: { seq: 'asc' },
        take: BATCH,
      });
      for (const row of rows) {
        checked += 1;
        const recomputed = computeHash(row.prevHash, {
          ...row,
          before: row.before as JsonValue | null,
          after: row.after as JsonValue | null,
          meta: row.meta as JsonValue | null,
        });
        if (row.prevHash !== prevHash || recomputed !== row.hash) {
          return this.done({
            ok: false,
            checked,
            firstBrokenSeq: row.seq.toString(),
            verifiedAt: new Date().toISOString(),
          });
        }
        prevHash = row.hash;
      }
      if (rows.length < BATCH) break;
      after = rows[rows.length - 1].seq;
    }
    return this.done({
      ok: true,
      checked,
      verifiedAt: new Date().toISOString(),
    });
  }

  /** Verifies and stores the result as `audit.lastVerification`. */
  async verifyAndStore(): Promise<AuditVerification> {
    const result = await this.verify();
    await this.settings.set(AUDIT_LAST_VERIFICATION_KEY, { ...result }, null);
    return result;
  }

  async last(): Promise<AuditVerification | null> {
    const value = await this.settings.get(AUDIT_LAST_VERIFICATION_KEY);
    return isVerification(value) ? value : null;
  }

  private done(result: AuditVerification): AuditVerification {
    if (!result.ok) {
      this.logger.error(
        `audit chain broken at seq ${result.firstBrokenSeq} (${result.checked} checked)`,
      );
    }
    return result;
  }
}

const isVerification = (value: unknown): value is AuditVerification =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as Record<string, unknown>).ok === 'boolean' &&
  typeof (value as Record<string, unknown>).checked === 'number' &&
  typeof (value as Record<string, unknown>).verifiedAt === 'string';

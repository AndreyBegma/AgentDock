import {
  AI_DIGEST_DEFAULTS,
  type AiDigestSettingsView,
  type UpdateAiDigestSettings,
} from '@nautelle/shared';
import { Injectable } from '@nestjs/common';
import type { AiDigestSettings } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import type { AuditContext } from '../audit/audit.types';
import { PrismaService } from '../database/prisma.service';

type Settings = Omit<AiDigestSettingsView, 'updatedAt'>;

const settingsOf = (row: AiDigestSettings | null): Settings =>
  row
    ? { enabled: row.enabled, time: row.time, timezone: row.timezone }
    : { ...AI_DIGEST_DEFAULTS };

/** A project's daily AI digest setting (#658): no row is off, 09:00 UTC. */
@Injectable()
export class AiDigestSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async view(projectId: string): Promise<AiDigestSettingsView> {
    const row = await this.prisma.aiDigestSettings.findUnique({
      where: { projectId },
    });
    return {
      ...settingsOf(row),
      updatedAt: row?.updatedAt.toISOString() ?? null,
    };
  }

  /** A project admin; audited as `project.update` with before and after. */
  async update(
    projectId: string,
    change: UpdateAiDigestSettings,
    actor: { userId: string; ctx: AuditContext },
  ): Promise<AiDigestSettingsView> {
    const before = settingsOf(
      await this.prisma.aiDigestSettings.findUnique({ where: { projectId } }),
    );
    const data = {
      enabled: change.enabled ?? before.enabled,
      time: change.time ?? before.time,
      timezone: change.timezone ?? before.timezone,
      updatedById: actor.userId,
    };
    const row = await this.prisma.aiDigestSettings.upsert({
      where: { projectId },
      create: { projectId, ...data },
      update: data,
    });
    const after = settingsOf(row);
    await this.audit.record({
      ...actor.ctx,
      action: 'project.update',
      target: { type: 'project', id: projectId },
      projectId,
      before: { aiDigest: before },
      after: { aiDigest: after },
      result: 'ok',
    });
    return { ...after, updatedAt: row.updatedAt.toISOString() };
  }
}

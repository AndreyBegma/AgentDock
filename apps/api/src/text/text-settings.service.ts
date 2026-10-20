import type { TextSettingsView } from '@nautelle/shared';
import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import type { AuditContext } from '../audit/audit.types';
import { PrismaService } from '../database/prisma.service';
import { TextNormalizer } from './text-normalizer';

/** The per-project switch (issue #271 D13): no row is on. */
@Injectable()
export class TextSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly normalizer: TextNormalizer,
    private readonly audit: AuditService,
  ) {}

  async view(projectId: string): Promise<TextSettingsView> {
    const row = await this.prisma.textSettings.findUnique({
      where: { projectId },
    });
    return {
      normalizeEnabled: row?.normalizeEnabled ?? true,
      updatedAt: row?.updatedAt.toISOString() ?? null,
    };
  }

  /** A project admin; audited as `text.settings_updated` (D15). */
  async update(
    projectId: string,
    normalizeEnabled: boolean,
    actor: { userId: string; ctx: AuditContext },
  ): Promise<TextSettingsView> {
    const before = await this.view(projectId);
    const row = await this.prisma.textSettings.upsert({
      where: { projectId },
      create: { projectId, normalizeEnabled, updatedById: actor.userId },
      update: { normalizeEnabled, updatedById: actor.userId },
    });
    // D11: what has not run yet is skipped; existing English stays.
    if (!normalizeEnabled) await this.normalizer.skipPending(projectId);
    await this.audit.record({
      ...actor.ctx,
      action: 'text.settings_updated',
      target: { type: 'project', id: projectId },
      projectId,
      before: { normalizeEnabled: before.normalizeEnabled },
      after: { normalizeEnabled: row.normalizeEnabled },
      result: 'ok',
    });
    return {
      normalizeEnabled: row.normalizeEnabled,
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}

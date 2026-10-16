import {
  STEWARD_DEFAULTS,
  type StewardSettings,
  type StewardSettingsView,
} from '@agentdock/shared';
import { Injectable, Logger } from '@nestjs/common';
import type { StewardSettings as StewardSettingsRow } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import type { AuditContext } from '../audit/audit.types';
import { PrismaService } from '../database/prisma.service';
import { RunnerWatchList } from '../runners/runner-watch-list';

const settingsOf = (row: StewardSettingsRow | null): StewardSettings =>
  row
    ? {
        enabled: row.enabled,
        silenceMinutes: row.silenceMinutes,
        digestTime: row.digestTime,
        autoNudge: row.autoNudge,
        autoDismiss: row.autoDismiss,
        autoResume: row.autoResume,
        trailerGuard: row.trailerGuard,
      }
    : STEWARD_DEFAULTS;

/**
 * The per-project Steward setting (#447 D16): no row is the defaults —
 * Steward on, every automatic action on.
 */
@Injectable()
export class StewardSettingsService {
  private readonly logger = new Logger(StewardSettingsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly watchList: RunnerWatchList,
  ) {}

  /** The setting the decisions read. */
  async of(projectId: string): Promise<StewardSettings> {
    return settingsOf(
      await this.prisma.stewardSettings.findUnique({ where: { projectId } }),
    );
  }

  async view(projectId: string): Promise<StewardSettingsView> {
    const row = await this.prisma.stewardSettings.findUnique({
      where: { projectId },
    });
    return {
      ...settingsOf(row),
      updatedAt: row?.updatedAt.toISOString() ?? null,
    };
  }

  /**
   * A project admin; audited with the setting before and after. The runner
   * is told at once: it applies `enabled`, the threshold and the trailer
   * guard itself (`stewardRunnerConfigOf`).
   */
  async update(
    projectId: string,
    settings: StewardSettings,
    actor: { userId: string; ctx: AuditContext },
  ): Promise<StewardSettingsView> {
    const before = await this.of(projectId);
    const data = { ...settings, updatedById: actor.userId };
    const row = await this.prisma.stewardSettings.upsert({
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
      before: { steward: before },
      after: { steward: after },
      result: 'ok',
    });
    try {
      await this.watchList.pushForProject(projectId);
    } catch (error) {
      // The runner picks the setting up at its next welcome.
      this.logger.warn(
        `project ${projectId}: steward config not pushed: ${(error as Error).message}`,
      );
    }
    return { ...after, updatedAt: row.updatedAt.toISOString() };
  }
}

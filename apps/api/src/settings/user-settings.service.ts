import {
  APP_VERSION,
  isPlanningModel,
  resolvePlanningModel,
  type UserSettingsView,
  type WhatsNewView,
  whatsNewView,
} from '@nautelle/shared';
import { BadRequestException, Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import type { AuditContext } from '../audit/audit.types';
import { PrismaService } from '../database/prisma.service';

/**
 * A person's own settings (#337 D9, `user_settings`). Every read and write is
 * keyed by the caller's id alone: there is no route that names another user.
 */
@Injectable()
export class UserSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async get(userId: string): Promise<UserSettingsView> {
    const row = await this.prisma.userSettings.findUnique({
      where: { userId },
      select: { planningModel: true },
    });
    return { planningModel: resolvePlanningModel(row?.planningModel) };
  }

  /** The model New Card and New Plan preselect, and a plan takes by default. */
  async planningModel(userId: string): Promise<string> {
    return (await this.get(userId)).planningModel;
  }

  /** `null` clears the setting back to `PLANNING_MODEL_DEFAULT`. */
  async update(
    userId: string,
    planningModel: string | null,
    ctx: AuditContext,
  ): Promise<UserSettingsView> {
    if (!isPlanningModel(planningModel)) {
      throw new BadRequestException(
        'planningModel must be a model of the catalog, or null',
      );
    }
    const before = await this.get(userId);
    await this.prisma.userSettings.upsert({
      where: { userId },
      update: { planningModel },
      create: { userId, planningModel },
    });
    const after = await this.get(userId);
    await this.audit.record({
      ...ctx,
      action: 'user.update',
      target: { type: 'user', id: userId },
      before: { planningModel: before.planningModel },
      after: { planningModel: after.planningModel },
      result: 'ok',
    });
    return after;
  }

  /** C-294: this build's version, and whether the caller has seen it. */
  async whatsNew(userId: string): Promise<WhatsNewView> {
    const row = await this.prisma.userSettings.findUnique({
      where: { userId },
      select: { seenVersion: true },
    });
    return whatsNewView(row?.seenVersion);
  }

  /**
   * C-294: the caller opened What's new on this build. Always the API's own
   * `APP_VERSION`, never a version the client names; not audited, as a read
   * receipt changes nothing anyone else sees.
   */
  async markWhatsNewSeen(userId: string): Promise<WhatsNewView> {
    await this.prisma.userSettings.upsert({
      where: { userId },
      update: { seenVersion: APP_VERSION },
      create: { userId, seenVersion: APP_VERSION },
    });
    return whatsNewView(APP_VERSION);
  }
}

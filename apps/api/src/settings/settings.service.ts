import { REGISTRATION_SETTING_KEY } from '@agentdock/shared';
import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import type { AuditContext } from '../audit/audit.types';
import { PrismaService } from '../database/prisma.service';

@Injectable()
export class SettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Closed unless an admin opened it — a missing row means closed (spec D3). */
  async isRegistrationOpen(): Promise<boolean> {
    const setting = await this.prisma.setting.findUnique({
      where: { key: REGISTRATION_SETTING_KEY },
    });
    return setting?.value === true;
  }

  async setRegistrationOpen(
    open: boolean,
    userId: string,
    ctx: AuditContext,
  ): Promise<boolean> {
    const before = await this.isRegistrationOpen();
    await this.prisma.setting.upsert({
      where: { key: REGISTRATION_SETTING_KEY },
      update: { value: open, updatedById: userId },
      create: {
        key: REGISTRATION_SETTING_KEY,
        value: open,
        updatedById: userId,
      },
    });
    await this.audit.record({
      ...ctx,
      action: 'settings.registration',
      target: { type: 'setting', id: REGISTRATION_SETTING_KEY },
      before: { open: before },
      after: { open },
      result: 'ok',
    });
    return open;
  }

  /** The raw JSON value of a setting, or null when it was never written. */
  async get(key: string): Promise<Prisma.JsonValue | null> {
    const setting = await this.prisma.setting.findUnique({ where: { key } });
    return setting?.value ?? null;
  }

  /** Writes a setting; `userId` null for values the system writes itself. */
  async set(
    key: string,
    value: Prisma.InputJsonValue,
    userId: string | null,
  ): Promise<void> {
    await this.prisma.setting.upsert({
      where: { key },
      update: { value, updatedById: userId },
      create: { key, value, updatedById: userId },
    });
  }
}

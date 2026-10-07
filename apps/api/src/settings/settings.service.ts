import { REGISTRATION_SETTING_KEY } from '@agentdock/shared';
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';

@Injectable()
export class SettingsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Closed unless an admin opened it — a missing row means closed (spec D3). */
  async isRegistrationOpen(): Promise<boolean> {
    const setting = await this.prisma.setting.findUnique({
      where: { key: REGISTRATION_SETTING_KEY },
    });
    return setting?.value === true;
  }

  async setRegistrationOpen(open: boolean, userId: string): Promise<boolean> {
    await this.prisma.setting.upsert({
      where: { key: REGISTRATION_SETTING_KEY },
      update: { value: open, updatedById: userId },
      create: {
        key: REGISTRATION_SETTING_KEY,
        value: open,
        updatedById: userId,
      },
    });
    return open;
  }
}

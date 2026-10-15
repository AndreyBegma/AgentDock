import { Module } from '@nestjs/common';
import { MeSettingsController } from './me-settings.controller';
import { SettingsService } from './settings.service';
import { UserSettingsService } from './user-settings.service';

/**
 * Site settings, and a person's own (`/me/settings`, #337 D9). The planner
 * reads the planning model through `UserSettingsService`.
 */
@Module({
  controllers: [MeSettingsController],
  providers: [SettingsService, UserSettingsService],
  exports: [SettingsService, UserSettingsService],
})
export class SettingsModule {}

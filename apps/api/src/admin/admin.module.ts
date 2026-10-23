import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SettingsModule } from '../settings/settings.module';
import {
  AdminSettingsController,
  AdminUsersController,
} from './admin.controller';
import { AdminUsersService } from './admin-users.service';

@Module({
  imports: [SettingsModule, AuthModule],
  controllers: [AdminUsersController, AdminSettingsController],
  providers: [AdminUsersService],
})
export class AdminModule {}

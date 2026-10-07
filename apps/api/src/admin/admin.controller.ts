import type { AdminUser, RegistrationState } from '@agentdock/shared';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import type { AuthUser } from '../auth/auth-request';
import { CurrentUser, Roles } from '../auth/decorators';
import { SettingsService } from '../settings/settings.service';
import { AdminUsersService } from './admin-users.service';
import {
  ApproveUserDto,
  ListUsersQuery,
  RegistrationStateDto,
  UpdateUserDto,
} from './dto';

@Roles('admin')
@Controller('admin/users')
export class AdminUsersController {
  constructor(private readonly users: AdminUsersService) {}

  @Get()
  list(@Query() query: ListUsersQuery): Promise<AdminUser[]> {
    return this.users.list(query.status);
  }

  @Post(':id/approve')
  @HttpCode(200)
  approve(
    @Param('id') id: string,
    @Body() dto: ApproveUserDto,
    @CurrentUser() admin: AuthUser,
  ): Promise<AdminUser> {
    return this.users.approve(id, dto.role, admin.id);
  }

  @Post(':id/reject')
  @HttpCode(200)
  reject(@Param('id') id: string): Promise<AdminUser> {
    return this.users.reject(id);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateUserDto,
  ): Promise<AdminUser> {
    return this.users.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@Param('id') id: string): Promise<void> {
    return this.users.remove(id);
  }
}

@Roles('admin')
@Controller('admin/settings')
export class AdminSettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get('registration')
  async registration(): Promise<RegistrationState> {
    return { open: await this.settings.isRegistrationOpen() };
  }

  @Put('registration')
  async setRegistration(
    @Body() dto: RegistrationStateDto,
    @CurrentUser() admin: AuthUser,
  ): Promise<RegistrationState> {
    return {
      open: await this.settings.setRegistrationOpen(dto.open, admin.id),
    };
  }
}

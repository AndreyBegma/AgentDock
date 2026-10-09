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
import type { AuditContext } from '../audit/audit.types';
import { AuditCtx } from '../audit/audit-context';
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
    @AuditCtx() ctx: AuditContext,
  ): Promise<AdminUser> {
    return this.users.approve(id, dto.role, admin.id, ctx);
  }

  @Post(':id/reject')
  @HttpCode(200)
  reject(
    @Param('id') id: string,
    @AuditCtx() ctx: AuditContext,
  ): Promise<AdminUser> {
    return this.users.reject(id, ctx);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateUserDto,
    @AuditCtx() ctx: AuditContext,
  ): Promise<AdminUser> {
    return this.users.update(id, dto, ctx);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(
    @Param('id') id: string,
    @AuditCtx() ctx: AuditContext,
  ): Promise<void> {
    return this.users.remove(id, ctx);
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
    @AuditCtx() ctx: AuditContext,
  ): Promise<RegistrationState> {
    return {
      open: await this.settings.setRegistrationOpen(dto.open, admin.id, ctx),
    };
  }
}

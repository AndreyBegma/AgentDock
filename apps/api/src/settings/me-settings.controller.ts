import type {
  UpdateUserSettingsRequest,
  UserSettingsView,
} from '@agentdock/shared';
import { Body, Controller, Get, Put } from '@nestjs/common';
import { IsDefined, IsString, MaxLength, ValidateIf } from 'class-validator';
import type { AuditContext } from '../audit/audit.types';
// From their own files: the barrels load `AuditModule` and `AuthModule`,
// and `AuthModule` imports this module.
import { AuditCtx } from '../audit/audit-context';
import type { AuthUser } from '../auth/auth-request';
import { CurrentUser } from '../auth/decorators';
import { UserSettingsService } from './user-settings.service';

/** `PUT /me/settings`: a catalog alias, or `null` for the default. */
export class UpdateUserSettingsDto implements UpdateUserSettingsRequest {
  @IsDefined()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(64)
  planningModel!: string | null;
}

/**
 * The caller's own settings (#337 D9). Any signed-in person; the row is the
 * caller's, so no role is involved and nobody reads anyone else's.
 */
@Controller('me')
export class MeSettingsController {
  constructor(private readonly settings: UserSettingsService) {}

  @Get('settings')
  get(@CurrentUser() user: AuthUser): Promise<UserSettingsView> {
    return this.settings.get(user.id);
  }

  @Put('settings')
  update(
    @CurrentUser() user: AuthUser,
    @AuditCtx() ctx: AuditContext,
    @Body() dto: UpdateUserSettingsDto,
  ): Promise<UserSettingsView> {
    return this.settings.update(user.id, dto.planningModel, ctx);
  }
}

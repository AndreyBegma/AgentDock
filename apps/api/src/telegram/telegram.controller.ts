import type {
  TelegramIntegrationStatus,
  TelegramLinkCode,
  TelegramLinkStatus,
} from '@agentdock/shared';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Post,
  Put,
} from '@nestjs/common';
import { AuditCtx } from '../audit';
import type { AuditContext } from '../audit/audit.types';
import { type AuthUser, CurrentUser, Roles } from '../auth';
import { TelegramBotTokenDto } from './dto';
import { TelegramIntegrationService } from './telegram-integration.service';
import { TelegramLinkingService } from './telegram-linking.service';

/** The caller's own Telegram link (spec 22 D9). No user id in any path. */
@Controller('notifications/telegram/link')
export class TelegramLinkController {
  constructor(private readonly linking: TelegramLinkingService) {}

  @Get()
  status(@CurrentUser() user: AuthUser): Promise<TelegramLinkStatus> {
    return this.linking.status(user.id);
  }

  @Post()
  @HttpCode(201)
  create(@CurrentUser() user: AuthUser): Promise<TelegramLinkCode> {
    return this.linking.createCode(user);
  }

  @Delete()
  @HttpCode(204)
  unlink(
    @CurrentUser() user: AuthUser,
    @AuditCtx() ctx: AuditContext,
  ): Promise<void> {
    return this.linking.unlink(user, ctx);
  }
}

/** The bot itself (spec 22 D8): admins only. */
@Roles('admin')
@Controller('admin/integrations/telegram')
export class TelegramAdminController {
  constructor(private readonly integration: TelegramIntegrationService) {}

  @Get()
  status(): Promise<TelegramIntegrationStatus> {
    return this.integration.status();
  }

  @Put()
  configure(
    @CurrentUser() admin: AuthUser,
    @AuditCtx() ctx: AuditContext,
    @Body() dto: TelegramBotTokenDto,
  ): Promise<TelegramIntegrationStatus> {
    return this.integration.configure(dto.token, admin, ctx);
  }

  @Delete()
  clear(@AuditCtx() ctx: AuditContext): Promise<TelegramIntegrationStatus> {
    return this.integration.clear(ctx);
  }

  @Post('test')
  @HttpCode(204)
  test(@CurrentUser() admin: AuthUser): Promise<void> {
    return this.integration.sendTest(admin);
  }
}

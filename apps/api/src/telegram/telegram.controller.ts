import type {
  TelegramIntegrationStatus,
  TelegramLinkCode,
  TelegramLinkStatus,
  TelegramSignInResponse,
} from '@nautelle/shared';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Post,
  Put,
  Req,
  Res,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { AuditCtx } from '../audit';
import type { AuditContext } from '../audit/audit.types';
import { requestOrigin } from '../audit/audit-context';
import {
  type AuthUser,
  CurrentUser,
  Public,
  Roles,
  SourceThrottledFilter,
  setSessionCookies,
} from '../auth';
import {
  TelegramBotTokenDto,
  TelegramLinkConfirmDto,
  TelegramSignInDto,
} from './dto';
import { TelegramIntegrationService } from './telegram-integration.service';
import { TelegramLinkingService } from './telegram-linking.service';
import { TelegramWebAppService } from './telegram-web-app.service';

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

  /** C-147: only this activates the chat that redeemed the code. */
  @Post('confirm')
  @HttpCode(200)
  confirm(
    @CurrentUser() user: AuthUser,
    @AuditCtx() ctx: AuditContext,
    @Body() dto: TelegramLinkConfirmDto,
  ): Promise<TelegramLinkStatus> {
    return this.linking.confirm(user, dto.id, ctx);
  }

  /** C-147: turns the waiting chat away. */
  @Delete('pending')
  @HttpCode(204)
  decline(
    @CurrentUser() user: AuthUser,
    @AuditCtx() ctx: AuditContext,
  ): Promise<void> {
    return this.linking.decline(user, ctx);
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

/**
 * #580: the Mini App's sign-in. Public — the HMAC of `initData` is the
 * credential — and throttled per IP like a password sign-in.
 */
@Controller('auth/telegram')
@UseFilters(SourceThrottledFilter)
export class TelegramWebAppController {
  constructor(private readonly webApp: TelegramWebAppService) {}

  @Public()
  @UseGuards(ThrottlerGuard)
  @Post()
  @HttpCode(200)
  async signIn(
    @Body() dto: TelegramSignInDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<TelegramSignInResponse> {
    const { session, ...signedIn } = await this.webApp.signIn(
      dto.initData,
      requestOrigin(request),
    );
    setSessionCookies(response, session);
    return signedIn;
  }
}

import type {
  AdminRunner,
  AdminRunnerDetail,
  PairingCodeResponse,
  PingResult,
} from '@nautelle/shared';
import { PAIRING_PATH, type PairingResponse } from '@nautelle/shared/protocol';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { Request } from 'express';
import type { AuditContext } from '../audit/audit.types';
import { AuditCtx, requestOrigin } from '../audit/audit-context';
import type { AuthUser } from '../auth/auth-request';
import { CurrentUser, Public, Roles } from '../auth/decorators';
import {
  CreateRunnerDto,
  PairRunnerDto,
  RunnerSettingsDto,
  UpdateRunnerDto,
} from './dto';
import { PairingService } from './pairing.service';
import {
  type LocalRunnerView,
  RunnerSettingsService,
} from './runner-settings.service';
import { RunnersService } from './runners.service';

/** D9: admin only, every route. */
@Roles('admin')
@Controller('admin/runners')
export class AdminRunnersController {
  constructor(
    private readonly runners: RunnersService,
    private readonly settings: RunnerSettingsService,
  ) {}

  @Post()
  create(
    @Body() dto: CreateRunnerDto,
    @CurrentUser() admin: AuthUser,
    @AuditCtx() ctx: AuditContext,
  ): Promise<PairingCodeResponse> {
    return this.runners.create(dto.name, admin.id, ctx);
  }

  @Get()
  list(): Promise<AdminRunner[]> {
    return this.runners.list();
  }

  @Get(':id')
  detail(@Param('id') id: string): Promise<AdminRunnerDetail> {
    return this.runners.detail(id);
  }

  /** The name, and spec 201's local user and away mode; only what is sent changes. */
  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateRunnerDto,
    @CurrentUser() admin: AuthUser,
    @AuditCtx() ctx: AuditContext,
  ): Promise<AdminRunner> {
    let runner: AdminRunner | null = null;
    if (dto.name !== undefined) {
      runner = await this.runners.rename(id, dto.name, ctx);
    }
    if (dto.localUserId !== undefined || dto.awayMode !== undefined) {
      await this.settings.update(
        id,
        { localUserId: dto.localUserId, awayMode: dto.awayMode },
        { userId: admin.id, isAdmin: true, ctx },
      );
      runner = null;
    }
    return runner ?? this.runners.summary(id);
  }

  @Post(':id/pairing-code')
  @HttpCode(200)
  pairingCode(
    @Param('id') id: string,
    @AuditCtx() ctx: AuditContext,
  ): Promise<PairingCodeResponse> {
    return this.runners.newPairingCode(id, ctx);
  }

  @Post(':id/ping')
  @HttpCode(200)
  ping(
    @Param('id') id: string,
    @AuditCtx() ctx: AuditContext,
  ): Promise<PingResult> {
    return this.runners.ping(id, ctx);
  }

  @Post(':id/revoke')
  @HttpCode(200)
  revoke(
    @Param('id') id: string,
    @AuditCtx() ctx: AuditContext,
  ): Promise<AdminRunner> {
    return this.runners.revoke(id, ctx);
  }
}

/**
 * Spec 201 "API": the runner settings a non-admin may reach — the local user
 * sets their own runner's away mode. A runner the caller is neither admin
 * nor local user of is 404.
 */
@Controller('runners')
export class RunnerSettingsController {
  constructor(private readonly settings: RunnerSettingsService) {}

  /** The runners the caller is the local user of. */
  @Get('local')
  local(@CurrentUser() user: AuthUser): Promise<LocalRunnerView[]> {
    return this.settings.localRunners(user.id);
  }

  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body() dto: RunnerSettingsDto,
    @CurrentUser() user: AuthUser,
    @AuditCtx() ctx: AuditContext,
  ): Promise<LocalRunnerView> {
    const runner = await this.settings.update(
      id,
      { localUserId: dto.localUserId, awayMode: dto.awayMode },
      { userId: user.id, isAdmin: user.role === 'admin', ctx },
    );
    return {
      id: runner.id,
      name: runner.name,
      localUserId: runner.localUserId,
      awayMode: runner.awayMode,
    };
  }
}

/** The only public runners route; throttled 10/min per IP (spec "API"). */
@Controller()
export class RunnerPairingController {
  constructor(private readonly pairing: PairingService) {}

  @Public()
  @UseGuards(ThrottlerGuard)
  @Post(PAIRING_PATH)
  @HttpCode(200)
  pair(
    @Body() dto: PairRunnerDto,
    @Req() request: Request,
  ): Promise<PairingResponse> {
    return this.pairing.pair(dto, requestOrigin(request));
  }
}

import type {
  AdminRunner,
  AdminRunnerDetail,
  PairingCodeResponse,
  PingResult,
} from '@agentdock/shared';
import { PAIRING_PATH, type PairingResponse } from '@agentdock/shared/protocol';
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
import { CreateRunnerDto, PairRunnerDto, RenameRunnerDto } from './dto';
import { PairingService } from './pairing.service';
import { RunnersService } from './runners.service';

/** D9: admin only, every route. */
@Roles('admin')
@Controller('admin/runners')
export class AdminRunnersController {
  constructor(private readonly runners: RunnersService) {}

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

  @Patch(':id')
  rename(
    @Param('id') id: string,
    @Body() dto: RenameRunnerDto,
    @AuditCtx() ctx: AuditContext,
  ): Promise<AdminRunner> {
    return this.runners.rename(id, dto.name, ctx);
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

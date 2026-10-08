import type {
  CurrentPricesResponse,
  PriceTestResponse,
  PriceVersionListResponse,
  PriceVersionSummary,
  RecomputeProgress,
} from '@agentdock/shared';
import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import type { AuditContext } from '../audit/audit.types';
import { AuditCtx } from '../audit/audit-context';
import type { AuthUser } from '../auth/auth-request';
import { CurrentUser, Roles } from '../auth/decorators';
import { CreatePriceVersionDto, PriceTestDto, RecomputeDto } from './dto';
import { PricesService } from './prices.service';
import { RecomputeService } from './recompute.service';

/** Spec 13 price administration — admins only (D9). */
@Roles('admin')
@Controller('admin/prices')
export class PricesController {
  constructor(
    private readonly prices: PricesService,
    private readonly recomputes: RecomputeService,
  ) {}

  @Get()
  current(): Promise<CurrentPricesResponse> {
    return this.prices.current();
  }

  @Get('versions')
  versions(): Promise<PriceVersionListResponse> {
    return this.prices.versions();
  }

  @Post('versions')
  createVersion(
    @Body() dto: CreatePriceVersionDto,
    @CurrentUser() admin: AuthUser,
    @AuditCtx() ctx: AuditContext,
  ): Promise<PriceVersionSummary> {
    return this.prices.createVersion(dto, admin.id, ctx);
  }

  @Post('test')
  @HttpCode(200)
  test(@Body() dto: PriceTestDto): Promise<PriceTestResponse> {
    return this.prices.test(dto);
  }

  @Post('recompute')
  @HttpCode(202)
  recompute(
    @Body() dto: RecomputeDto,
    @CurrentUser() admin: AuthUser,
    @AuditCtx() ctx: AuditContext,
  ): Promise<RecomputeProgress> {
    return this.recomputes.start(dto, admin.id, ctx);
  }

  @Get('recompute/:id')
  progress(@Param('id') id: string): Promise<RecomputeProgress> {
    return this.recomputes.get(id);
  }
}

import type {
  InboundDryRunResult,
  InboundTriggerDetail,
  InboundTriggerView,
  InboundTriggerWithSecret,
} from '@agentdock/shared';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { AuditCtx } from '../../audit';
import type { AuditContext } from '../../audit/audit.types';
import { type AuthUser, CurrentUser, Roles } from '../../auth';
import { TriggerCreateDto, TriggerDryRunDto, TriggerUpdateDto } from './dto';
import { TriggersService } from './triggers.service';

/** `/admin/triggers*` (spec 26 "API", D16): admins only. */
@Roles('admin')
@Controller('admin/triggers')
export class TriggersController {
  constructor(private readonly triggers: TriggersService) {}

  @Get()
  list(): Promise<InboundTriggerView[]> {
    return this.triggers.list();
  }

  @Post()
  create(
    @CurrentUser() user: AuthUser,
    @AuditCtx() ctx: AuditContext,
    @Body() dto: TriggerCreateDto,
  ): Promise<InboundTriggerWithSecret> {
    return this.triggers.create(dto, { userId: user.id, ctx });
  }

  @Get(':id')
  detail(@Param('id') id: string): Promise<InboundTriggerDetail> {
    return this.triggers.detail(id);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AuthUser,
    @AuditCtx() ctx: AuditContext,
    @Param('id') id: string,
    @Body() dto: TriggerUpdateDto,
  ): Promise<InboundTriggerView> {
    return this.triggers.update(id, dto, { userId: user.id, ctx });
  }

  @Delete(':id')
  @HttpCode(204)
  remove(
    @CurrentUser() user: AuthUser,
    @AuditCtx() ctx: AuditContext,
    @Param('id') id: string,
  ): Promise<void> {
    return this.triggers.remove(id, { userId: user.id, ctx });
  }

  @Post(':id/rotate-secret')
  @HttpCode(200)
  rotateSecret(
    @CurrentUser() user: AuthUser,
    @AuditCtx() ctx: AuditContext,
    @Param('id') id: string,
  ): Promise<InboundTriggerWithSecret> {
    return this.triggers.rotateSecret(id, { userId: user.id, ctx });
  }

  @Post(':id/dry-run')
  @HttpCode(200)
  dryRun(
    @Param('id') id: string,
    @Body() dto: TriggerDryRunDto,
  ): Promise<InboundDryRunResult> {
    return this.triggers.dryRun(id, dto.payload);
  }
}

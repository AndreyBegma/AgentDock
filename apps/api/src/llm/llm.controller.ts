import type { LlmKeyTestResult, LlmSettingsView } from '@agentdock/shared';
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
} from '@nestjs/common';
import type { AuditContext } from '../audit/audit.types';
import { AuditCtx } from '../audit/audit-context';
import type { AuthUser } from '../auth/auth-request';
import { CurrentUser, Roles } from '../auth/decorators';
import {
  LlmDefaultModelDto,
  LlmKeyUpdateDto,
  LlmProviderUpdateDto,
  ProviderParam,
} from './dto';
import { LlmSettingsService } from './llm-settings.service';

/** Admin › AI providers (ADR-0057). Every route is admin-only. */
@Roles('admin')
@Controller('admin/llm')
export class LlmController {
  constructor(private readonly llm: LlmSettingsService) {}

  @Get()
  view(): Promise<LlmSettingsView> {
    return this.llm.view();
  }

  @Put('providers/:provider/key')
  setKey(
    @Param() { provider }: ProviderParam,
    @Body() dto: LlmKeyUpdateDto,
    @CurrentUser() admin: AuthUser,
    @AuditCtx() ctx: AuditContext,
  ): Promise<LlmSettingsView> {
    return this.llm.setKey(provider, dto.key, admin.id, ctx);
  }

  @Delete('providers/:provider/key')
  deleteKey(
    @Param() { provider }: ProviderParam,
    @CurrentUser() admin: AuthUser,
    @AuditCtx() ctx: AuditContext,
  ): Promise<LlmSettingsView> {
    return this.llm.deleteKey(provider, admin.id, ctx);
  }

  @Post('providers/:provider/key/test')
  @HttpCode(200)
  testKey(
    @Param() { provider }: ProviderParam,
    @AuditCtx() ctx: AuditContext,
  ): Promise<LlmKeyTestResult> {
    return this.llm.testKey(provider, ctx);
  }

  @Patch('providers/:provider')
  updateProvider(
    @Param() { provider }: ProviderParam,
    @Body() dto: LlmProviderUpdateDto,
    @CurrentUser() admin: AuthUser,
    @AuditCtx() ctx: AuditContext,
  ): Promise<LlmSettingsView> {
    return this.llm.updateProvider(provider, dto, admin.id, ctx);
  }

  @Put('default-model')
  setDefaultModel(
    @Body() dto: LlmDefaultModelDto,
    @CurrentUser() admin: AuthUser,
    @AuditCtx() ctx: AuditContext,
  ): Promise<LlmSettingsView> {
    return this.llm.setDefaultModel(dto, admin.id, ctx);
  }
}

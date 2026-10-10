import type {
  WebhookDeliveryPage,
  WebhookDeliveryView,
  WebhookSettingsView,
  WebhookView,
  WebhookWithSecret,
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
  Put,
  Query,
} from '@nestjs/common';
import { AuditCtx } from '../../audit';
import type { AuditContext } from '../../audit/audit.types';
import { type AuthUser, CurrentUser, Roles } from '../../auth';
import { WebhookSettingsService } from '../common';
import {
  WebhookCreateDto,
  WebhookDeliveriesQuery,
  WebhookSettingsDto,
  WebhookUpdateDto,
} from './dto';
import { WebhooksAdminService } from './webhooks-admin.service';

/** Outbound webhooks (docs/specs/26-webhooks.md "API", D16): admins only. */
@Roles('admin')
@Controller('admin/webhooks')
export class WebhooksController {
  constructor(private readonly webhooks: WebhooksAdminService) {}

  @Get()
  list(): Promise<WebhookView[]> {
    return this.webhooks.list();
  }

  @Post()
  @HttpCode(201)
  create(
    @Body() dto: WebhookCreateDto,
    @CurrentUser() admin: AuthUser,
    @AuditCtx() ctx: AuditContext,
  ): Promise<WebhookWithSecret> {
    return this.webhooks.create(dto, admin.id, ctx);
  }

  @Get(':id')
  get(@Param('id') id: string): Promise<WebhookView> {
    return this.webhooks.get(id);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() dto: WebhookUpdateDto,
    @AuditCtx() ctx: AuditContext,
  ): Promise<WebhookView> {
    return this.webhooks.update(id, dto, ctx);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(
    @Param('id') id: string,
    @AuditCtx() ctx: AuditContext,
  ): Promise<void> {
    return this.webhooks.remove(id, ctx);
  }

  @Get(':id/deliveries')
  deliveries(
    @Param('id') id: string,
    @Query() query: WebhookDeliveriesQuery,
  ): Promise<WebhookDeliveryPage> {
    return this.webhooks.deliveries(id, query);
  }

  @Post(':id/deliveries/:deliveryId/redeliver')
  @HttpCode(202)
  redeliver(
    @Param('id') id: string,
    @Param('deliveryId') deliveryId: string,
    @AuditCtx() ctx: AuditContext,
  ): Promise<WebhookDeliveryView> {
    return this.webhooks.redeliver(id, deliveryId, ctx);
  }

  @Post(':id/test')
  @HttpCode(202)
  test(
    @Param('id') id: string,
    @AuditCtx() ctx: AuditContext,
  ): Promise<WebhookDeliveryView> {
    return this.webhooks.test(id, ctx);
  }

  @Post(':id/close-circuit')
  @HttpCode(200)
  closeCircuit(
    @Param('id') id: string,
    @AuditCtx() ctx: AuditContext,
  ): Promise<WebhookView> {
    return this.webhooks.closeCircuit(id, ctx);
  }

  @Post(':id/rotate-secret')
  @HttpCode(200)
  rotateSecret(
    @Param('id') id: string,
    @AuditCtx() ctx: AuditContext,
  ): Promise<WebhookWithSecret> {
    return this.webhooks.rotateSecret(id, ctx);
  }
}

/** D15: the private-target allowlist. Audited by `WebhookSettingsService`. */
@Roles('admin')
@Controller('admin/settings/webhooks')
export class WebhookSettingsController {
  constructor(private readonly settings: WebhookSettingsService) {}

  @Get()
  async get(): Promise<WebhookSettingsView> {
    return {
      allowedPrivateTargets: await this.settings.allowedPrivateTargets(),
    };
  }

  @Put()
  async set(
    @Body() dto: WebhookSettingsDto,
    @CurrentUser() admin: AuthUser,
    @AuditCtx() ctx: AuditContext,
  ): Promise<WebhookSettingsView> {
    return {
      allowedPrivateTargets: await this.settings.setAllowedPrivateTargets(
        dto.allowedPrivateTargets,
        admin.id,
        ctx,
      ),
    };
  }
}

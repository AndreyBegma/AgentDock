import { Module } from '@nestjs/common';
import { LiveModule } from '../../live/live.module';
import { WebhooksCommonModule } from '../common';
import { WebhookDeliveryWorker } from './webhook-delivery-worker';
import { WebhookDispatcher } from './webhook-dispatcher';
import { WebhookLive } from './webhook-live';
import { WebhookRetentionJob } from './webhook-retention.job';
import {
  WebhookSettingsController,
  WebhooksController,
} from './webhooks.controller';
import { WebhooksAdminService } from './webhooks-admin.service';

/**
 * Outbound webhooks (docs/specs/26-webhooks.md D9–D15, D18): the dispatcher,
 * the delivery worker and circuit breaker, `/admin/webhooks*`,
 * `/admin/settings/webhooks` and the retention of both directions' deliveries.
 */
@Module({
  imports: [WebhooksCommonModule, LiveModule],
  controllers: [WebhooksController, WebhookSettingsController],
  providers: [
    WebhookLive,
    WebhooksAdminService,
    WebhookDispatcher,
    WebhookDeliveryWorker,
    WebhookRetentionJob,
  ],
  exports: [WebhookDispatcher, WebhookDeliveryWorker, WebhookRetentionJob],
})
export class OutboundWebhooksModule {}

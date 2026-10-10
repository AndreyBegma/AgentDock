import { Module } from '@nestjs/common';
import { WebhooksCommonModule } from '../common';

/**
 * Outbound webhooks (docs/specs/26-webhooks.md D9–D15, D18): the dispatcher,
 * the delivery worker and circuit breaker, `/admin/webhooks*`,
 * `/admin/settings/webhooks` and retention. Filled in by the i26-outbound slot.
 */
@Module({
  imports: [WebhooksCommonModule],
})
export class OutboundWebhooksModule {}

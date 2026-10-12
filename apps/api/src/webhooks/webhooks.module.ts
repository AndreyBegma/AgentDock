import { Module } from '@nestjs/common';
import { WebhooksCommonModule } from './common';
import { InboundWebhooksModule } from './inbound/inbound.module';
import { OutboundWebhooksModule } from './outbound/outbound.module';

/**
 * Webhooks (docs/specs/26-webhooks.md), both directions. Admin-managed,
 * audited, on PostgreSQL alone (ADR-0007); nothing a webhook carries reaches
 * a shell (ADR-0010).
 */
@Module({
  imports: [
    WebhooksCommonModule,
    InboundWebhooksModule,
    OutboundWebhooksModule,
  ],
})
export class WebhooksModule {}

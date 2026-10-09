import { Module } from '@nestjs/common';
import { WebhooksCommonModule } from '../common';

/**
 * Inbound triggers (docs/specs/26-webhooks.md D1–D7): `POST /hooks/:publicId`,
 * argument templating, firing, and `/admin/triggers*`. Filled in by the
 * i26-inbound slot.
 */
@Module({
  imports: [WebhooksCommonModule],
})
export class InboundWebhooksModule {}

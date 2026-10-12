import {
  type InboundDeliveryCreatedData,
  WEBHOOK_LIVE_EVENTS,
} from '@agentdock/shared';
import { Injectable, Logger } from '@nestjs/common';
import type { InboundDelivery } from '@prisma/client';
import { LiveService } from '../../live/live.service';

/**
 * D20: `inbound_delivery.created` on the `admin` topic — when a delivery is
 * recorded and again when its firing settles, so a log in view follows it.
 */
@Injectable()
export class InboundLive {
  private readonly logger = new Logger(InboundLive.name);

  constructor(private readonly live: LiveService) {}

  delivery(row: InboundDelivery): void {
    const data: InboundDeliveryCreatedData = {
      triggerId: row.triggerId,
      id: row.id.toString(),
      deliveryId: row.deliveryId,
      status: row.status,
      reason: row.reason,
    };
    try {
      this.live.publish(
        'admin',
        WEBHOOK_LIVE_EVENTS.inboundDeliveryCreated,
        data,
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.warn(`inbound delivery not published: ${reason}`);
    }
  }
}

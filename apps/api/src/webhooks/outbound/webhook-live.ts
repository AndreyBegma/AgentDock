import {
  WEBHOOK_LIVE_EVENTS,
  type WebhookCircuitState,
  type WebhookDeliveryUpdatedData,
} from '@agentdock/shared';
import { Injectable, Logger } from '@nestjs/common';
import type { WebhookDelivery } from '@prisma/client';
import { LiveService } from '../../live/live.service';

/** D20: delivery status changes on the `admin` topic. Best effort, never throws. */
@Injectable()
export class WebhookLive {
  private readonly logger = new Logger(WebhookLive.name);

  constructor(private readonly live: LiveService) {}

  delivery(row: WebhookDelivery, circuitState: WebhookCircuitState): void {
    const data: WebhookDeliveryUpdatedData = {
      webhookId: row.webhookId,
      deliveryId: row.id,
      status: row.status,
      attempts: row.attempts,
      responseCode: row.responseCode,
      nextAttemptAt: row.nextAttemptAt.toISOString(),
      circuitState,
    };
    try {
      this.live.publish('admin', WEBHOOK_LIVE_EVENTS.deliveryUpdated, data);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.warn(`webhook live update not sent: ${reason}`);
    }
  }
}

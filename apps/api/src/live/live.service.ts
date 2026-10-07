import {
  type LiveEventMessage,
  type LiveTopic,
  liveTopicSchema,
  MAX_LIVE_MESSAGE_BYTES,
} from '@agentdock/shared';
import { Injectable } from '@nestjs/common';
import { LiveConnections } from './live-connections';

/**
 * What other modules publish live updates through (spec D14). Delivery is
 * best effort to the sockets subscribed on this API instance right now; a
 * client that was offline re-reads state over REST when it reconnects.
 */
@Injectable()
export class LiveService {
  constructor(private readonly connections: LiveConnections) {}

  /**
   * Sends `event { topic, event: type, data, ts }` to every subscriber of
   * `topic`; returns how many sockets it reached. Subscribers were
   * authorized when they subscribed and are re-checked every minute.
   * Throws on a malformed topic or a frame over `MAX_LIVE_MESSAGE_BYTES`.
   */
  publish(topic: LiveTopic, type: string, data: unknown): number {
    if (!liveTopicSchema.safeParse(topic).success) {
      throw new Error(`malformed live topic "${topic}"`);
    }
    const message: LiveEventMessage = {
      type: 'event',
      topic,
      event: type,
      data,
      ts: new Date().toISOString(),
    };
    const frame = JSON.stringify(message);
    if (Buffer.byteLength(frame) > MAX_LIVE_MESSAGE_BYTES) {
      throw new Error(
        `live event ${type} on ${topic} exceeds ${MAX_LIVE_MESSAGE_BYTES} bytes`,
      );
    }
    let delivered = 0;
    for (const client of this.connections.subscribers(topic)) {
      if (client.sendRaw(frame)) delivered += 1;
    }
    return delivered;
  }
}

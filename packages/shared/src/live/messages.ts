import { z } from 'zod';
import { liveTopicSchema } from './topics';

// Client → server

export const liveSubscribeMessageSchema = z.object({
  type: z.literal('subscribe'),
  topic: liveTopicSchema,
});

export const liveUnsubscribeMessageSchema = z.object({
  type: z.literal('unsubscribe'),
  topic: liveTopicSchema,
});

export const livePingMessageSchema = z.object({ type: z.literal('ping') });

export const liveClientMessageSchema = z.discriminatedUnion('type', [
  liveSubscribeMessageSchema,
  liveUnsubscribeMessageSchema,
  livePingMessageSchema,
]);
export type LiveClientMessage = z.infer<typeof liveClientMessageSchema>;

// Server → client

export const LIVE_ERROR_CODES = [
  /** The topic exists but this user may not read it. */
  'forbidden',
  /** No authorizer is registered for the topic's prefix (yet). */
  'unknown_topic',
  /** The connection already holds `MAX_LIVE_SUBSCRIPTIONS`. */
  'too_many_subscriptions',
  /** The frame is not JSON, not a known message, or names a malformed topic. */
  'invalid_message',
  /** The topic names something that does not exist — a slot of another project (spec 18 D6). */
  'not_found',
  /** The topic's viewer cap is reached, here or on the runner (spec 18 D4). */
  'too_many_viewers',
] as const;
export const liveErrorCodeSchema = z.enum(LIVE_ERROR_CODES);
export type LiveErrorCode = z.infer<typeof liveErrorCodeSchema>;

export const liveSubscribedMessageSchema = z.object({
  type: z.literal('subscribed'),
  topic: liveTopicSchema,
});

export const liveErrorMessageSchema = z.object({
  type: z.literal('error'),
  topic: liveTopicSchema.optional(),
  code: liveErrorCodeSchema,
});

/**
 * A domain change on `topic`. `type` names it (`runner.status`, …); each
 * domain defines the `data` schema of its own types.
 */
export const liveEventMessageSchema = z.object({
  type: z.literal('event'),
  topic: liveTopicSchema,
  event: z.string().min(1),
  data: z.unknown(),
  ts: z.iso.datetime(),
});

export const livePongMessageSchema = z.object({ type: z.literal('pong') });

export const liveServerMessageSchema = z.discriminatedUnion('type', [
  liveSubscribedMessageSchema,
  liveErrorMessageSchema,
  liveEventMessageSchema,
  livePongMessageSchema,
]);
export type LiveServerMessage = z.infer<typeof liveServerMessageSchema>;
export type LiveEventMessage = z.infer<typeof liveEventMessageSchema>;

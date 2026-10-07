import { z } from 'zod';

/** WebSocket path the web app dials on the API for live updates. */
export const LIVE_SOCKET_PATH = '/live';

/** Subscriptions one connection may hold at a time. */
export const MAX_LIVE_SUBSCRIPTIONS = 50;
/** Open `/live` connections one login session may hold at a time. */
export const MAX_LIVE_CONNECTIONS_PER_SESSION = 5;
/** Largest frame either side may send, in bytes. */
export const MAX_LIVE_MESSAGE_BYTES = 64 * 1024;

/** Close codes the API uses on a `/live` socket. */
export const LIVE_CLOSE_CODES = {
  /** No session cookie, or the session is unknown, expired, revoked or its user is no longer active. */
  unauthorized: 4401,
  /** The `Origin` header is missing or is not the web app's. */
  forbiddenOrigin: 4403,
  /** The session already holds `MAX_LIVE_CONNECTIONS_PER_SESSION` sockets; the new one is refused. */
  tooManyConnections: 4429,
} as const;

export type LiveCloseCode =
  (typeof LIVE_CLOSE_CODES)[keyof typeof LIVE_CLOSE_CODES];

/** Topic prefixes that carry an id: `<prefix>:<id>`. */
export const LIVE_TOPIC_PREFIXES = ['runner', 'project', 'user'] as const;
export type LiveTopicPrefix = (typeof LIVE_TOPIC_PREFIXES)[number] | 'admin';

const topicPattern = new RegExp(
  `^(?:admin|(?:${LIVE_TOPIC_PREFIXES.join('|')}):[A-Za-z0-9_-]{1,64})$`,
);

/** `admin`, `runner:<id>`, `project:<id>` or `user:<id>`. */
export const liveTopicSchema = z.string().regex(topicPattern);
export type LiveTopic = z.infer<typeof liveTopicSchema>;

/** The parts of a well-formed topic; `id` is null for `admin`. */
export const parseLiveTopic = (
  topic: LiveTopic,
): { prefix: LiveTopicPrefix; id: string | null } => {
  const colon = topic.indexOf(':');
  if (colon < 0) return { prefix: 'admin', id: null };
  return {
    prefix: topic.slice(0, colon) as LiveTopicPrefix,
    id: topic.slice(colon + 1),
  };
};

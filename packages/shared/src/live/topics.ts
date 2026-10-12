import { z } from 'zod';
import { SLOT_NAME_MAX_LENGTH } from '../protocol/commands/control';

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
export type LiveTopicPrefix =
  | (typeof LIVE_TOPIC_PREFIXES)[number]
  | 'admin'
  | 'pane'
  | 'run';

/** Also `skillRunIdSchema`'s rule (protocol/commands/skills.ts). */
const ID = '[A-Za-z0-9_-]{1,64}';
/** `slotNameSchema`'s rule (protocol/commands/control.ts), as a fragment. */
const SLOT = `[a-z0-9][a-z0-9-]{0,${SLOT_NAME_MAX_LENGTH - 1}}`;

const topicPattern = new RegExp(
  `^(?:admin|(?:${LIVE_TOPIC_PREFIXES.join('|')}):${ID}|pane:${ID}:${SLOT}|run:${ID}:${ID})$`,
);

/**
 * `admin`, `runner:<id>`, `project:<id>`, `user:<id>`,
 * `pane:<projectId>:<slot>` (spec 18) — whose id is `<projectId>:<slot>` — or
 * `run:<projectId>:<runId>`, a skill run's live log (spec 24 D13).
 */
export const liveTopicSchema = z.string().regex(topicPattern);
export type LiveTopic = z.infer<typeof liveTopicSchema>;

/** Live topic of a skill run's log (spec 24 D13). */
export const runTopic = (projectId: string, runId: string): string =>
  `run:${projectId}:${runId}`;

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

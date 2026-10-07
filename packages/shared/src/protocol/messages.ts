import { z } from 'zod';
import { capabilitiesSchema } from './capabilities';
import { commandErrorCodeSchema } from './commands';
import { eventSchema, seqCursorSchema } from './envelope';

/** An `events` batch carries at most this many events… */
export const MAX_EVENTS_PER_BATCH = 500;
/** …and at most this many bytes of serialized JSON. */
export const MAX_EVENTS_BATCH_BYTES = 256 * 1024;

/** Every message may carry an `id`; `command` and its replies require one. */
const messageId = z.string().min(1);
const base = { id: messageId.optional() };

// Runner → server

export const helloMessageSchema = z.object({
  ...base,
  type: z.literal('hello'),
  runnerVersion: z.string().min(1),
  protocolVersion: z.number().int().positive(),
  hostname: z.string().min(1),
  os: z.string().min(1),
  arch: z.string().min(1),
  capabilities: capabilitiesSchema,
  /** Highest seq the runner has seen acked, `0` when none. */
  lastAckedSeq: seqCursorSchema,
});

export const heartbeatMessageSchema = z.object({
  ...base,
  type: z.literal('heartbeat'),
  ts: z.iso.datetime(),
  /** 1, 5 and 15 minute load averages. */
  load: z.tuple([z.number(), z.number(), z.number()]),
  tmuxSessions: z.number().int().nonnegative(),
  collectors: z.record(
    z.string().min(1),
    z.object({ ok: z.boolean(), error: z.string().optional() }),
  ),
});

export const eventsMessageSchema = z.object({
  ...base,
  type: z.literal('events'),
  events: z.array(eventSchema).min(1).max(MAX_EVENTS_PER_BATCH),
});

export const commandResultMessageSchema = z
  .object({
    type: z.literal('command.result'),
    id: messageId,
    ok: z.boolean(),
    output: z.unknown().optional(),
    error: z
      .object({
        code: commandErrorCodeSchema,
        message: z.string().optional(),
      })
      .optional(),
  })
  .refine((m) => m.ok === (m.error === undefined), {
    message: '`error` is required when ok is false and forbidden when true',
    path: ['error'],
  });

export const commandProgressMessageSchema = z.object({
  type: z.literal('command.progress'),
  id: messageId,
  chunk: z.string(),
});

export const paneMessageSchema = z.object({
  ...base,
  type: z.literal('pane'),
  projectId: z.string().min(1),
  slot: z.string().min(1),
  lines: z.array(z.string()),
  cursor: z.object({
    x: z.number().int().nonnegative(),
    y: z.number().int().nonnegative(),
  }),
});

// Server → runner

export const welcomeMessageSchema = z.object({
  ...base,
  type: z.literal('welcome'),
  runnerId: z.string().min(1),
  config: z.object({
    projects: z.array(
      z.object({ id: z.string().min(1), root: z.string().min(1) }),
    ),
    pollIntervalsMs: z.record(z.string().min(1), z.number().int().positive()),
  }),
  /** Highest contiguous seq persisted; the runner resends everything above it. */
  ackedSeq: seqCursorSchema,
});

export const ackMessageSchema = z.object({
  ...base,
  type: z.literal('ack'),
  /** Highest contiguous seq persisted. */
  seq: seqCursorSchema,
});

/**
 * `name` and `args` are deliberately loose here: an unknown command must reach
 * the dispatcher and be answered `unknown_command`, not fail to parse.
 * `parseCommand` checks both against the allowlist.
 */
export const commandMessageSchema = z.object({
  type: z.literal('command'),
  id: messageId,
  name: z.string().min(1),
  args: z.unknown(),
});

const paneTarget = {
  ...base,
  projectId: z.string().min(1),
  slot: z.string().min(1),
};

export const subscribeMessageSchema = z.object({
  ...paneTarget,
  type: z.literal('subscribe'),
});

export const unsubscribeMessageSchema = z.object({
  ...paneTarget,
  type: z.literal('unsubscribe'),
});

const runnerMessages = [
  helloMessageSchema,
  heartbeatMessageSchema,
  eventsMessageSchema,
  commandResultMessageSchema,
  commandProgressMessageSchema,
  paneMessageSchema,
] as const;

const serverMessages = [
  welcomeMessageSchema,
  ackMessageSchema,
  commandMessageSchema,
  subscribeMessageSchema,
  unsubscribeMessageSchema,
] as const;

/** Messages the runner sends. An unknown `type` fails to parse. */
export const runnerMessageSchema = z.discriminatedUnion('type', [
  ...runnerMessages,
]);
/** Messages the server sends. An unknown `type` fails to parse. */
export const serverMessageSchema = z.discriminatedUnion('type', [
  ...serverMessages,
]);
/** Every message in either direction. */
export const messageSchema = z.discriminatedUnion('type', [
  ...runnerMessages,
  ...serverMessages,
]);

export type HelloMessage = z.infer<typeof helloMessageSchema>;
export type HeartbeatMessage = z.infer<typeof heartbeatMessageSchema>;
export type EventsMessage = z.infer<typeof eventsMessageSchema>;
export type CommandResultMessage = z.infer<typeof commandResultMessageSchema>;
export type CommandProgressMessage = z.infer<
  typeof commandProgressMessageSchema
>;
export type PaneMessage = z.infer<typeof paneMessageSchema>;
export type WelcomeMessage = z.infer<typeof welcomeMessageSchema>;
export type AckMessage = z.infer<typeof ackMessageSchema>;
export type CommandMessage = z.infer<typeof commandMessageSchema>;
export type SubscribeMessage = z.infer<typeof subscribeMessageSchema>;
export type UnsubscribeMessage = z.infer<typeof unsubscribeMessageSchema>;

export type RunnerMessage = z.infer<typeof runnerMessageSchema>;
export type ServerMessage = z.infer<typeof serverMessageSchema>;
export type Message = z.infer<typeof messageSchema>;
export type MessageType = Message['type'];

export const runnerMessageTypes = runnerMessages.map((s) => s.shape.type.value);
export const serverMessageTypes = serverMessages.map((s) => s.shape.type.value);

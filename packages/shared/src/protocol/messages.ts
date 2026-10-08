import { z } from 'zod';
import { capabilitiesSchema } from './capabilities';
import { commandErrorCodeSchema } from './commands';
import { eventSchema, seqCursorSchema } from './envelope';
import {
  anySubscribeMessageSchema,
  paneMessageSchema,
  runLogMessageSchema,
  subscribeErrorMessageSchema,
  unsubscribeMessageSchema,
} from './pane';
import { watchedProjectSchema } from './projects';
import {
  terminalCloseMessageSchema,
  terminalDataMessageSchema,
  terminalResizeMessageSchema,
} from './terminal';

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

// Server → runner

/** What the server tells a runner to watch; carried by `welcome` and `config`. */
export const runnerServerConfigSchema = z.object({
  projects: z.array(watchedProjectSchema),
  pollIntervalsMs: z.record(z.string().min(1), z.number().int().positive()),
});
export type RunnerServerConfig = z.infer<typeof runnerServerConfigSchema>;

export const welcomeMessageSchema = z.object({
  ...base,
  type: z.literal('welcome'),
  runnerId: z.string().min(1),
  config: runnerServerConfigSchema,
  /** Highest contiguous seq persisted; the runner resends everything above it. */
  ackedSeq: seqCursorSchema,
});

/**
 * The config changed mid-connection (a project connected or deleted). Applied
 * exactly like `welcome.config`; it does not touch the ack cursor.
 */
export const configMessageSchema = z.object({
  ...base,
  type: z.literal('config'),
  config: runnerServerConfigSchema,
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

/** Sent in both directions; listed once in `messageSchema`. */
const bothWayMessages = [
  terminalDataMessageSchema,
  terminalCloseMessageSchema,
] as const;

const runnerMessages = [
  helloMessageSchema,
  heartbeatMessageSchema,
  eventsMessageSchema,
  commandResultMessageSchema,
  commandProgressMessageSchema,
  paneMessageSchema,
  subscribeErrorMessageSchema,
  runLogMessageSchema,
  ...bothWayMessages,
] as const;

const serverOnlyMessages = [
  welcomeMessageSchema,
  configMessageSchema,
  ackMessageSchema,
  commandMessageSchema,
  anySubscribeMessageSchema,
  unsubscribeMessageSchema,
  terminalResizeMessageSchema,
] as const;

const serverMessages = [...serverOnlyMessages, ...bothWayMessages] as const;

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
  ...serverOnlyMessages,
]);

export type HelloMessage = z.infer<typeof helloMessageSchema>;
export type HeartbeatMessage = z.infer<typeof heartbeatMessageSchema>;
export type EventsMessage = z.infer<typeof eventsMessageSchema>;
export type CommandResultMessage = z.infer<typeof commandResultMessageSchema>;
export type CommandProgressMessage = z.infer<
  typeof commandProgressMessageSchema
>;
export type WelcomeMessage = z.infer<typeof welcomeMessageSchema>;
export type ConfigMessage = z.infer<typeof configMessageSchema>;
export type AckMessage = z.infer<typeof ackMessageSchema>;
export type CommandMessage = z.infer<typeof commandMessageSchema>;

export type RunnerMessage = z.infer<typeof runnerMessageSchema>;
export type ServerMessage = z.infer<typeof serverMessageSchema>;
export type Message = z.infer<typeof messageSchema>;
export type MessageType = Message['type'];

export const runnerMessageTypes = runnerMessages.map((s) => s.shape.type.value);
/** `subscribe` is a union by `kind`; its first option names the type. */
export const serverMessageTypes = serverMessages.map((s) =>
  'shape' in s ? s.shape.type.value : s.options[0].shape.type.value,
);

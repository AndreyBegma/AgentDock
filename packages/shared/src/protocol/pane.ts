import { z } from 'zod';
import { slotNameSchema } from './commands/control';
import { absolutePathSchema } from './projects';

/**
 * Live read-only worker pane (spec 18). The server subscribes the runner to a
 * slot's tmux pane; the runner streams frames until the last viewer leaves.
 * There is no message that carries input to the pane — that is M3.6.
 */

/** Capture interval while at least one viewer is subscribed (D1). */
export const PANE_CAPTURE_INTERVAL_MS = 1000;
/** History depth of the first `full` frame; later captures take the visible screen (D1). */
export const PANE_HISTORY_LINES = 2000;
/** A `full` frame is resent this often, even when patches would do (D2). */
export const PANE_FULL_RESEND_MS = 60_000;
/** The runner stops a capture loop at most this long after `unsubscribe` (D3). */
export const PANE_UNSUBSCRIBE_STOP_MS = 2000;
/** Concurrent pane subscriptions per runner; one more is `too_many_viewers` (D4). */
export const PANE_MAX_SUBSCRIPTIONS = 10;
/** Browser viewers per slot on the API; one more is `too_many_viewers` (D4). */
export const PANE_MAX_VIEWERS_PER_SLOT = 20;
/** Serialized frame cap; lines are dropped from the top to fit (D4). */
export const PANE_MAX_FRAME_BYTES = 256 * 1024;

/** Live topic a browser subscribes to on `/live`. */
export const paneTopic = (projectId: string, slot: string): string =>
  `pane:${projectId}:${slot}`;

/** Live event types the API relays on a pane topic. */
export const PANE_LIVE_EVENTS = {
  /** `data` is a `PaneFrame` of type `full` or `patch`. */
  frame: 'pane.frame',
  /** The session is gone; the last frame stays on screen (D7). */
  ended: 'pane.ended',
} as const;

/** Chosen by the server per subscription; every reply to it echoes the id. */
const subscriptionId = z.string().min(1);

const cursorSchema = z.object({
  x: z.number().int().nonnegative(),
  y: z.number().int().nonnegative(),
});

export const paneFullFrameSchema = z.object({
  type: z.literal('full'),
  lines: z.array(z.string()),
  cursor: cursorSchema,
});

/** Replaces lines from index `from` to the end of the previous frame. */
export const panePatchFrameSchema = z.object({
  type: z.literal('patch'),
  from: z.number().int().nonnegative(),
  lines: z.array(z.string()),
});

export const paneEndedFrameSchema = z.object({ type: z.literal('ended') });

export const paneFrameSchema = z.discriminatedUnion('type', [
  paneFullFrameSchema,
  panePatchFrameSchema,
  paneEndedFrameSchema,
]);

export const paneSubscribeErrorCodeSchema = z.enum([
  'not_found',
  'too_many_viewers',
  'forbidden',
]);

// Server → runner

/**
 * Start streaming a slot's pane. The runner checks `root` against its watch
 * list and the slot's worktree against the `.wt-<repo>-<slot>` rule (D6).
 */
export const subscribeMessageSchema = z.object({
  type: z.literal('subscribe'),
  id: subscriptionId,
  kind: z.literal('pane'),
  projectId: z.string().min(1),
  root: absolutePathSchema,
  slot: slotNameSchema,
});

export const unsubscribeMessageSchema = z.object({
  type: z.literal('unsubscribe'),
  id: subscriptionId,
});

// Runner → server

export const paneMessageSchema = z.object({
  type: z.literal('pane'),
  id: subscriptionId,
  frame: paneFrameSchema,
});

/** The subscription was refused; nothing further is sent for this `id`. */
export const subscribeErrorMessageSchema = z.object({
  type: z.literal('subscribe.error'),
  id: subscriptionId,
  code: paneSubscribeErrorCodeSchema,
});

export type PaneFullFrame = z.infer<typeof paneFullFrameSchema>;
export type PanePatchFrame = z.infer<typeof panePatchFrameSchema>;
export type PaneEndedFrame = z.infer<typeof paneEndedFrameSchema>;
export type PaneFrame = z.infer<typeof paneFrameSchema>;
export type PaneSubscribeErrorCode = z.infer<
  typeof paneSubscribeErrorCodeSchema
>;
export type SubscribeMessage = z.infer<typeof subscribeMessageSchema>;
export type UnsubscribeMessage = z.infer<typeof unsubscribeMessageSchema>;
export type PaneMessage = z.infer<typeof paneMessageSchema>;
export type SubscribeErrorMessage = z.infer<typeof subscribeErrorMessageSchema>;

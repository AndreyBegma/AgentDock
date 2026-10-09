import { z } from 'zod';

/**
 * Interactive terminal attach (docs/specs/29-terminal-attach.md). An admin
 * attaches to a tmux session the runner resolves itself; the runner spawns
 * `tmux attach-session` in a PTY and the bytes flow both ways as
 * `terminal.data`. The attach is opened by the `terminal.attach` command
 * (`commands/terminal.ts`), whose `id` names the stream every message below
 * echoes.
 *
 * Every schema here is strict: an unknown field fails to parse instead of
 * being dropped, so nothing can ride along with bytes headed for a live PTY.
 * Input bytes are not filtered for control sequences — an attach is a raw
 * terminal by design (D4, D6). The guards are the admin-only command,
 * read-only by default, and the runner and the API both dropping input on a
 * `read` attach.
 */

/** A ticket is single use and valid this long after it is issued (D5). */
export const TERMINAL_TICKET_TTL_MS = 30_000;
/** Default of `TERMINAL_IDLE_TIMEOUT_SEC` on the API (D7). */
export const TERMINAL_IDLE_TIMEOUT_SEC_DEFAULT = 900;
/** Default of `TERMINAL_MAX_DURATION_SEC` on the API (D7). */
export const TERMINAL_MAX_DURATION_SEC_DEFAULT = 14_400;
/** Default of the runner's `terminal.maxAttachesPerRunner`; one more is `busy` (D7). */
export const TERMINAL_MAX_ATTACHES_PER_RUNNER = 2;
/** Decoded bytes of one `terminal.data` message or one browser binary frame (D6). */
export const TERMINAL_MAX_DATA_BYTES = 64 * 1024;
/** Base64 length of `TERMINAL_MAX_DATA_BYTES`: 4 characters per 3 bytes, padded. */
export const TERMINAL_MAX_DATA_B64_LENGTH =
  Math.ceil(TERMINAL_MAX_DATA_BYTES / 3) * 4;
/** The dedicated browser WebSocket on the API port (D5); not `/live`. */
export const TERMINAL_WS_PATH = '/terminal';

/** Bounds of the PTY size a client may ask for, on attach and on resize. */
export const TERMINAL_COLS = { min: 10, max: 500 } as const;
export const TERMINAL_ROWS = { min: 2, max: 200 } as const;

export const terminalColsSchema = z
  .number()
  .int()
  .min(TERMINAL_COLS.min)
  .max(TERMINAL_COLS.max);
export const terminalRowsSchema = z
  .number()
  .int()
  .min(TERMINAL_ROWS.min)
  .max(TERMINAL_ROWS.max);

/**
 * `read` attaches with `tmux attach-session -r -f ignore-size`; `write` with
 * the plain `attach-session` (D4). Taking control is a second attach.
 */
export const terminalModeSchema = z.enum(['read', 'write']);
export type TerminalMode = z.infer<typeof terminalModeSchema>;

/** Why an attach ended; carried by `terminal.close` and the `terminal.detached` audit record. */
export const terminalCloseReasonSchema = z.enum([
  /** The admin detached, or the browser socket closed. */
  'client',
  /** No input (write) or no traffic (read) for the idle timeout (D7). */
  'idle',
  /** The attach reached the maximum duration (D7). */
  'max_duration',
  /** The `tmux attach` client exited: the session ended or was detached by tmux. */
  'session_ended',
  /** The runner or API socket dropped. */
  'socket',
]);
export type TerminalCloseReason = z.infer<typeof terminalCloseReasonSchema>;

/**
 * Chosen by the server per attach and sent as `terminal.attach`'s `id`.
 * Restricted to a token, because the runner keys its attaches and its logs by it.
 */
export const terminalIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,128}$/, 'must match ^[A-Za-z0-9_-]{1,128}$');

const BASE64 =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** Bytes a canonical, padded base64 string decodes to. */
export const base64DecodedBytes = (b64: string): number =>
  (b64.length / 4) * 3 - (b64.match(/=*$/)?.[0].length ?? 0);

/** Padded base64 of 1 to `TERMINAL_MAX_DATA_BYTES` bytes. */
export const terminalDataB64Schema = z
  .string()
  .min(4)
  .max(TERMINAL_MAX_DATA_B64_LENGTH)
  .regex(BASE64, 'must be padded base64')
  .refine((b64) => base64DecodedBytes(b64) <= TERMINAL_MAX_DATA_BYTES, {
    message: `must decode to at most ${TERMINAL_MAX_DATA_BYTES} bytes`,
  });

// Both directions

/** Output of the PTY (runner → server), or input to it (server → runner, `write` only). */
export const terminalDataMessageSchema = z.strictObject({
  type: z.literal('terminal.data'),
  id: terminalIdSchema,
  b64: terminalDataB64Schema,
});

/**
 * Ends an attach. The runner then kills the `tmux attach` client with SIGHUP;
 * no terminal path ever kills the target session (D7). Nothing more is sent
 * for this `id` after it, in either direction.
 */
export const terminalCloseMessageSchema = z.strictObject({
  type: z.literal('terminal.close'),
  id: terminalIdSchema,
  reason: terminalCloseReasonSchema,
});

// Server → runner

/** Resizes the PTY. On a `read` attach `ignore-size` keeps the agent's window as it is (D4). */
export const terminalResizeMessageSchema = z.strictObject({
  type: z.literal('terminal.resize'),
  id: terminalIdSchema,
  cols: terminalColsSchema,
  rows: terminalRowsSchema,
});

// Browser ↔ API on `TERMINAL_WS_PATH`

/**
 * JSON text frames from the browser (D6). Bytes travel as binary frames of at
 * most `TERMINAL_MAX_DATA_BYTES`; there is no other text frame.
 */
export const terminalClientFrameSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('resize'),
    cols: terminalColsSchema,
    rows: terminalRowsSchema,
  }),
  z.strictObject({ type: z.literal('close') }),
]);

export type TerminalDataMessage = z.infer<typeof terminalDataMessageSchema>;
export type TerminalCloseMessage = z.infer<typeof terminalCloseMessageSchema>;
export type TerminalResizeMessage = z.infer<typeof terminalResizeMessageSchema>;
export type TerminalClientFrame = z.infer<typeof terminalClientFrameSchema>;

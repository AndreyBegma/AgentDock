import { z } from 'zod';
import {
  type TerminalMode,
  type TerminalTargetKind,
  terminalCloseReasonSchema,
  terminalModeSchema,
} from '../protocol';

/**
 * HTTP and browser-socket contracts of the interactive terminal attach
 * (docs/specs/29-terminal-attach.md "API", D5–D7). The runner-facing
 * messages and the browser's own text frames are in `protocol/terminal.ts`.
 */

/** `POST /terminal/tickets` (admin). `slot` with `kind: 'slot'`, `runId` with `kind: 'skill_run'`. */
export interface TerminalTicketRequest {
  kind: TerminalTargetKind;
  projectId: string;
  slot?: string;
  runId?: string;
  mode: TerminalMode;
}

/**
 * A single-use ticket for one upgrade of `/terminal?ticket=…`, valid until
 * `expiresAt` and only with the session that asked for it (D5).
 */
export interface TerminalTicketResponse {
  ticket: string;
  expiresAt: string;
}

/** What an attach is attached to; the session name is the runner's to resolve (D2). */
export interface TerminalTargetView {
  kind: TerminalTargetKind;
  projectId: string;
  slot: string | null;
  runId: string | null;
}

/** One live attach, as `GET /terminal/active?projectId=` lists it (D9). */
export interface TerminalAttachView {
  id: string;
  target: TerminalTargetView;
  mode: TerminalMode;
  user: { id: string; email: string };
  /** When the attach was opened, ISO 8601. */
  since: string;
}

/** Stable codes in the `error` field of a terminal route's error body. */
export const TERMINAL_ERROR = {
  notFound: 'not_found',
  /** Another admin holds the read-write attach of this target (D7); `heldBy` names them. */
  busy: 'busy',
  /** The project's runner reports `terminal: false`: no PTY, or `terminal.attach` disabled (D3, D10). */
  unsupported: 'unsupported',
} as const;
export type TerminalErrorCode =
  (typeof TERMINAL_ERROR)[keyof typeof TERMINAL_ERROR];

export interface TerminalErrorBody {
  statusCode: number;
  error: TerminalErrorCode;
  message: string;
  heldBy?: { id: string; email: string };
}

/**
 * Query of the `/terminal` upgrade: the ticket, and the size the PTY opens
 * with (`TERMINAL_COLS` × `TERMINAL_ROWS`; 80 × 24 when absent).
 */
export const TERMINAL_WS_QUERY = {
  ticket: 'ticket',
  cols: 'cols',
  rows: 'rows',
} as const;
export const TERMINAL_DEFAULT_SIZE = { cols: 80, rows: 24 } as const;

/**
 * Close codes of `/terminal`. An attach that ran ends with `ended`, and its
 * close reason is a `TerminalCloseReason`; every other code is a refusal,
 * preceded by an `error` frame when the socket got that far.
 */
export const TERMINAL_CLOSE_CODES = {
  /** The attach ended; the reason is in the close frame and the `closed` frame. */
  ended: 4000,
  /** The ticket is missing, unknown, expired, already used, or another session's (D5). */
  invalidTicket: 4400,
  /** No session cookie, or the session is unknown, expired or revoked. */
  unauthorized: 4401,
  /** The `Origin` header is missing or is not the web app's (D5). */
  forbiddenOrigin: 4403,
  /** The project is gone or not visible, or the runner found no such session (D2). */
  notFound: 4404,
  /** The caller is no longer an admin (D1). */
  forbidden: 4406,
  /** A read-write attach of the target is held, or the runner is at its cap (D7). */
  busy: 4409,
  /** The runner cannot attach: no PTY, or `terminal.attach` is disabled there (D3, D10). */
  unsupported: 4501,
  /** The runner is offline or did not answer the attach in time. */
  runnerUnavailable: 4503,
} as const;
export type TerminalCloseCode =
  (typeof TERMINAL_CLOSE_CODES)[keyof typeof TERMINAL_CLOSE_CODES];

/** Why `/terminal` refused or could not open an attach; the `error` frame's `code`. */
export const terminalRefusalCodeSchema = z.enum([
  'not_found',
  'forbidden',
  'busy',
  'unsupported',
  'disabled',
  'runner_unavailable',
]);
export type TerminalRefusalCode = z.infer<typeof terminalRefusalCodeSchema>;

const userRefSchema = z.object({ id: z.string(), email: z.string() });

/**
 * JSON text frames the API sends on `/terminal` (D6). Terminal output itself
 * travels as binary frames.
 */
export const terminalServerFrameSchema = z.discriminatedUnion('type', [
  /** The runner attached; binary output follows. */
  z.object({
    type: z.literal('attached'),
    id: z.string(),
    mode: terminalModeSchema,
    session: z.string(),
  }),
  /** The attach was refused; the socket closes next with a refusal code. */
  z.object({
    type: z.literal('error'),
    code: terminalRefusalCodeSchema,
    message: z.string().optional(),
    heldBy: userRefSchema.optional(),
  }),
  /** The attach ended; the socket closes next with `ended`. */
  z.object({
    type: z.literal('closed'),
    reason: terminalCloseReasonSchema,
  }),
]);
export type TerminalServerFrame = z.infer<typeof terminalServerFrameSchema>;

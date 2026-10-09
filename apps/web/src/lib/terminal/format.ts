import {
  TERMINAL_CLOSE_CODES,
  TERMINAL_ERROR,
  TERMINAL_WS_QUERY,
  type TerminalErrorBody,
  type TerminalRefusalCode,
} from '@agentdock/shared';
import {
  TERMINAL_COLS,
  TERMINAL_MAX_DATA_BYTES,
  TERMINAL_ROWS,
  TERMINAL_WS_PATH,
  type TerminalCloseReason,
} from '@agentdock/shared/protocol';
import { ApiError } from '../api';

const DEFAULT_LIVE_URL = 'ws://localhost:8180/live';

/** The `/terminal` socket sits on the API port beside `/live` (spec 29 D5). */
export function terminalSocketUrl(
  ticket: string,
  size: { cols: number; rows: number },
  liveUrl: string = process.env.NEXT_PUBLIC_LIVE_URL ?? DEFAULT_LIVE_URL,
): string {
  const url = new URL(liveUrl);
  url.pathname = TERMINAL_WS_PATH;
  url.search = '';
  url.searchParams.set(TERMINAL_WS_QUERY.ticket, ticket);
  url.searchParams.set(TERMINAL_WS_QUERY.cols, String(size.cols));
  url.searchParams.set(TERMINAL_WS_QUERY.rows, String(size.rows));
  return url.toString();
}

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, Math.round(value)));

/** A size the API accepts, whatever the fit addon measured. */
export function clampSize(cols: number, rows: number) {
  return {
    cols: clamp(cols, TERMINAL_COLS.min, TERMINAL_COLS.max),
    rows: clamp(rows, TERMINAL_ROWS.min, TERMINAL_ROWS.max),
  };
}

const encoder = new TextEncoder();

/**
 * Keystrokes as UTF-8 binary frames of at most `TERMINAL_MAX_DATA_BYTES`. A
 * pasted block is split on character boundaries, never in the middle of a
 * multi-byte character.
 */
export function inputFrames(text: string): Uint8Array<ArrayBuffer>[] {
  const frames: Uint8Array<ArrayBuffer>[] = [];
  let chunk = '';
  let size = 0;
  for (const char of text) {
    const bytes = encoder.encode(char).length;
    if (size + bytes > TERMINAL_MAX_DATA_BYTES) {
      frames.push(encoder.encode(chunk));
      chunk = '';
      size = 0;
    }
    chunk += char;
    size += bytes;
  }
  if (chunk) frames.push(encoder.encode(chunk));
  return frames;
}

export type TerminalPhase =
  | 'requesting'
  | 'connecting'
  | 'attached'
  | 'ended'
  | 'refused';

export const TERMINAL_PHASE_LABEL: Record<TerminalPhase, string> = {
  requesting: 'Requesting access…',
  connecting: 'Connecting…',
  attached: 'Attached',
  ended: 'Detached',
  refused: 'Not attached',
};

export const CLOSE_REASON_LABEL: Record<TerminalCloseReason, string> = {
  client: 'You detached. The session keeps running.',
  idle: 'Detached after sitting idle. The session keeps running.',
  max_duration:
    'Detached at the maximum attach time. The session keeps running.',
  session_ended: 'The session ended.',
  socket: 'The connection to the runner was lost. The session keeps running.',
};

const REFUSAL_LABEL: Record<TerminalRefusalCode, string> = {
  not_found: 'That session no longer exists.',
  forbidden: 'Only administrators can attach to a terminal.',
  busy: 'Someone else holds the read-write attach, or the runner is at its attach limit.',
  unsupported: 'This runner cannot attach a terminal.',
  disabled: 'Terminal attach is disabled on this runner.',
  runner_unavailable: 'The runner is offline or did not answer.',
};

export function describeRefusal(
  code: TerminalRefusalCode,
  heldBy?: { email: string },
): string {
  if (code === 'busy' && heldBy) {
    return `${heldBy.email} holds the read-write attach of this session.`;
  }
  return REFUSAL_LABEL[code];
}

/** A sentence for a socket that closed without an `error` or `closed` frame. */
export function describeCloseCode(code: number): string {
  switch (code) {
    case TERMINAL_CLOSE_CODES.invalidTicket:
      return 'The access ticket expired or was already used. Try again.';
    case TERMINAL_CLOSE_CODES.unauthorized:
      return 'Your session has ended. Sign in again.';
    case TERMINAL_CLOSE_CODES.forbiddenOrigin:
      return 'This page is not allowed to open a terminal.';
    case TERMINAL_CLOSE_CODES.notFound:
      return REFUSAL_LABEL.not_found;
    case TERMINAL_CLOSE_CODES.forbidden:
      return REFUSAL_LABEL.forbidden;
    case TERMINAL_CLOSE_CODES.busy:
      return REFUSAL_LABEL.busy;
    case TERMINAL_CLOSE_CODES.unsupported:
      return REFUSAL_LABEL.unsupported;
    case TERMINAL_CLOSE_CODES.runnerUnavailable:
      return REFUSAL_LABEL.runner_unavailable;
    default:
      return 'The connection was lost. The session keeps running.';
  }
}

/** A sentence for a refused `POST /terminal/tickets`. */
export function describeTicketError(error: unknown): string {
  if (!(error instanceof ApiError)) return 'Could not reach the server.';
  const body = error.body as Partial<TerminalErrorBody> | null;
  switch (body?.error) {
    case TERMINAL_ERROR.busy:
      return describeRefusal('busy', body.heldBy);
    case TERMINAL_ERROR.unsupported:
      return REFUSAL_LABEL.unsupported;
    case TERMINAL_ERROR.notFound:
      return REFUSAL_LABEL.not_found;
    default:
      break;
  }
  if (error.status === 403) return REFUSAL_LABEL.forbidden;
  if (error.status === 404) return REFUSAL_LABEL.not_found;
  return error.message;
}

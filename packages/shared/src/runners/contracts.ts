import type {
  Capabilities,
  CommandErrorCode,
  EventSource,
  Runtime,
} from '../protocol';

/**
 * Derived, never stored: `online` while a socket is open and the last
 * heartbeat is recent, `stale` when it is not, `offline` with no socket (or
 * never paired — see `pairedAt`), `revoked` once revoked (spec D5, D10).
 */
export const RUNNER_STATUSES = [
  'online',
  'stale',
  'offline',
  'revoked',
] as const;
export type RunnerStatus = (typeof RUNNER_STATUSES)[number];

/** A socket whose last heartbeat is older than this reads `stale` (spec D5). */
export const RUNNER_STALE_AFTER_MS = 45_000;

/** A pairing code is valid this long after it is issued (spec D1). */
export const PAIRING_CODE_TTL_MS = 10 * 60_000;

export const RUNNER_NAME_MAX_LENGTH = 100;

/** Stable codes in the `error` field of a runners route's error body. */
export const RUNNER_ERROR = {
  /** Pairing code invalid, expired or already used (protocol `pairingErrorSchema`). */
  invalidCode: 'invalid_code',
  notFound: 'not_found',
  /** The action is not allowed in the runner's state (e.g. a revoked runner). */
  invalidTransition: 'invalid_transition',
  /** Not in the command allowlist, or its args fail the command's schema. */
  invalidCommand: 'invalid_command',
  /** The caller's role is below the command's minimum role. */
  forbidden: 'forbidden',
} as const;
export type RunnerErrorCode = (typeof RUNNER_ERROR)[keyof typeof RUNNER_ERROR];

export interface RunnerErrorBody {
  statusCode: number;
  error: RunnerErrorCode;
  message: string;
}

/** A row of `GET /admin/runners`. Dates are ISO strings. */
export interface AdminRunner {
  id: string;
  name: string;
  status: RunnerStatus;
  hostname: string | null;
  version: string | null;
  protocolVersion: number | null;
  os: string | null;
  arch: string | null;
  /** Profiles in the runner's latest `hello` (missing ones excluded). */
  profilesCount: number;
  /** `null` until the runner has paired. */
  pairedAt: string | null;
  lastSeenAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

/** A runtime profile mirrored from the runner's config (ADR-0006). */
export interface AdminRuntimeProfile {
  id: string;
  /** The profile `id` in the runner config. */
  key: string;
  runtime: Runtime;
  label: string;
  binary: string | null;
  /** Paths only — credentials never leave the runner. */
  env: Record<string, string>;
  args: string[];
  authenticated: boolean;
  /** Absent from the runner's latest `hello`; kept because runs reference it. */
  missing: boolean;
  updatedAt: string;
}

export interface AdminRunnerEvent {
  seq: number;
  ts: string;
  type: string;
  source: EventSource;
  projectRepo: string | null;
  slot: string | null;
  issue: number | null;
  data: unknown;
  receivedAt: string;
}

/** The latest heartbeat of the live connection; `null` when offline. */
export interface RunnerHeartbeat {
  receivedAt: string;
  load: [number, number, number];
  tmuxSessions: number;
  collectors: Record<string, { ok: boolean; error?: string }>;
}

/** `GET /admin/runners/:id`. */
export interface AdminRunnerDetail extends AdminRunner {
  capabilities: Capabilities | null;
  profiles: AdminRuntimeProfile[];
  /** The 50 most recent events, newest first. */
  events: AdminRunnerEvent[];
  heartbeat: RunnerHeartbeat | null;
  /** Highest contiguous event `seq` persisted. */
  ackedSeq: number;
}

export interface CreateRunnerRequest {
  name: string;
}

export interface RenameRunnerRequest {
  name: string;
}

/**
 * `POST /admin/runners` and `POST /admin/runners/:id/pairing-code`. The only
 * responses that ever carry a pairing code.
 */
export interface PairingCodeResponse {
  runner: AdminRunner;
  /** `XXXX-XXXX`, shown once. */
  pairingCode: string;
  expiresAt: string;
  /** The command to run on the machine. */
  command: string;
}

/** `POST /admin/runners/:id/ping`. `unknown`: no answer within the timeout, or offline. */
export type PingResult =
  | { status: 'ok'; rttMs: number; ts: string }
  | { status: 'error'; error: { code: CommandErrorCode; message?: string } }
  | { status: 'unknown' };

/** The install / pair command shown with a pairing code. */
export const pairCommand = (server: string, code: string): string =>
  `agentdock-runner pair --server ${server} --code ${code}`;

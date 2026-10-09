import type { InboundTemplateError, InboundTriggerAction } from './actions';
import type { WebhookEnvelope, WebhookEventType } from './events';

/**
 * HTTP contracts, limits and codes of webhooks (docs/specs/26-webhooks.md):
 * inbound triggers (`POST /hooks/:publicId`, `/admin/triggers*`) and outbound
 * webhooks (`/admin/webhooks*`, `/admin/settings/webhooks`).
 */

// ─── Headers and signatures (D2, D13) ───────────────────────────────────────

export const WEBHOOK_HEADERS = {
  /** Inbound: unix seconds, the signed `<timestamp>`. */
  timestamp: 'X-AgentDock-Timestamp',
  /** Inbound: the caller's unique id; outbound: the delivery id. */
  delivery: 'X-AgentDock-Delivery',
  /** Inbound `sha256=<hex>`; outbound `t=<unix>,v1=<hex>`. */
  signature: 'X-AgentDock-Signature',
  /** Outbound: the envelope's `type`. */
  event: 'X-AgentDock-Event',
} as const;

/** D2: a timestamp further than this from the server's clock is refused. */
export const INBOUND_TIMESTAMP_TOLERANCE_SEC = 5 * 60;
/** D2: longest `X-AgentDock-Delivery`. */
export const INBOUND_DELIVERY_ID_MAX_CHARS = 64;
/** D2: how long a delivery id is remembered for replay detection. */
export const INBOUND_NONCE_TTL_MS = 24 * 60 * 60 * 1000;
/** D1: largest inbound body. */
export const INBOUND_BODY_MAX_BYTES = 256 * 1024;
/** D1: the public route's prefix. */
export const INBOUND_HOOK_PATH_PREFIX = '/hooks';
/** D1: length of a trigger's `publicId`. */
export const TRIGGER_PUBLIC_ID_LENGTH = 24;

/** URL path of a trigger: `/hooks/<publicId>`. */
export const inboundHookPath = (publicId: string): string =>
  `${INBOUND_HOOK_PATH_PREFIX}/${publicId}`;

// ─── Inbound limits (D6) ────────────────────────────────────────────────────

/** Accepted deliveries per trigger per hour — the token bucket's size. */
export const INBOUND_RATE_PER_HOUR = 30;
/** One token comes back every this many milliseconds. */
export const INBOUND_REFILL_INTERVAL_MS =
  (60 * 60 * 1000) / INBOUND_RATE_PER_HOUR;

// ─── Secrets (D17) ──────────────────────────────────────────────────────────

/** Random bytes of a trigger or webhook secret, shown base64url once. */
export const WEBHOOK_SECRET_BYTES = 32;
/** After rotation the previous inbound secret still verifies this long. */
export const PREVIOUS_SECRET_GRACE_MS = 24 * 60 * 60 * 1000;

// ─── Outbound delivery (D12, D14, D18) ──────────────────────────────────────

/** D11: dispatcher poll interval. */
export const WEBHOOK_DISPATCH_INTERVAL_MS = 2_000;
/** D12: delivery worker poll interval. */
export const WEBHOOK_WORKER_INTERVAL_MS = 5_000;
/** D12: deliveries one worker tick claims. */
export const WEBHOOK_CLAIM_BATCH = 20;
/** D12: per-attempt timeout. */
export const WEBHOOK_REQUEST_TIMEOUT_MS = 10_000;
/** D12: the receiver's response body is stored up to this many bytes. */
export const WEBHOOK_RESPONSE_BODY_MAX_BYTES = 2048;
/** D12: attempts before a delivery is `failed`. */
export const WEBHOOK_MAX_ATTEMPTS = 8;
/** D12: the delay after the first failed attempt; it doubles each time. */
export const WEBHOOK_RETRY_BASE_MS = 30_000;
/** D12: ± this fraction of jitter on every retry delay. */
export const WEBHOOK_RETRY_JITTER = 0.2;
/** D14: consecutive failed attempts that open a webhook's circuit. */
export const WEBHOOK_CIRCUIT_THRESHOLD = 10;
/** D14: how long an open circuit holds before one half-open attempt. */
export const WEBHOOK_CIRCUIT_OPEN_MS = 15 * 60 * 1000;
/** D18: deliveries of both directions are kept this many days. */
export const WEBHOOK_RETENTION_DAYS = 30;

/**
 * D12: the delay before attempt `attempt + 1`, after `attempt` failed
 * attempts (1-based): 30 s × 2^(attempt−1), ±20 %. `random` is in [0, 1).
 */
export const webhookRetryDelayMs = (
  attempt: number,
  random: () => number = Math.random,
): number => {
  const base = WEBHOOK_RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1);
  const jitter = (random() * 2 - 1) * WEBHOOK_RETRY_JITTER;
  return Math.round(base * (1 + jitter));
};

// ─── Statuses and reasons ───────────────────────────────────────────────────

export const INBOUND_DELIVERY_STATUSES = [
  'accepted',
  'skipped',
  'rejected',
  'started',
  'failed',
] as const;
export type InboundDeliveryStatus = (typeof INBOUND_DELIVERY_STATUSES)[number];

/** `inbound_deliveries.reason`, beside D4's `InboundTemplateError`s. */
export const INBOUND_DELIVERY_REASONS = {
  /** D6: the trigger's previous run is still `running`. */
  previousStillRunning: 'previous_still_running',
  /** D5: the creator is no longer an active admin; the trigger was disabled. */
  creatorNotAuthorized: 'creator_not_authorized',
  /** D6: `beforeFire()` (#25 D12, #28 budgets) denied the firing. */
  beforeFireDenied: 'before_fire_denied',
  /** The project's runner is not online. */
  runnerOffline: 'runner_offline',
  /** The runner refused the command, or it failed. */
  commandFailed: 'command_failed',
} as const;
export type InboundDeliveryReason =
  | (typeof INBOUND_DELIVERY_REASONS)[keyof typeof INBOUND_DELIVERY_REASONS]
  | InboundTemplateError;

export const WEBHOOK_DELIVERY_STATUSES = [
  'pending',
  'succeeded',
  'failed',
] as const;
export type WebhookDeliveryStatus = (typeof WEBHOOK_DELIVERY_STATUSES)[number];

export const WEBHOOK_CIRCUIT_STATES = ['closed', 'open', 'half_open'] as const;
export type WebhookCircuitState = (typeof WEBHOOK_CIRCUIT_STATES)[number];

/** `webhook_deliveries.error` of a failed attempt that got no 2xx. */
export const WEBHOOK_ATTEMPT_ERRORS = {
  /** D15: the host resolved to a refused address. */
  blockedAddress: 'blocked_address',
  /** D15: plain `http://` to a host that is not allowlisted. */
  httpsRequired: 'https_required',
  /** The URL no longer parses, or the host does not resolve. */
  unresolvable: 'unresolvable',
  /** D12: a 3xx — redirects are never followed. */
  redirect: 'redirect',
  /** D12: no answer within `WEBHOOK_REQUEST_TIMEOUT_MS`. */
  timeout: 'timeout',
  /** The connection failed. */
  network: 'network_error',
  /** The receiver answered with a status outside 2xx and 3xx. */
  httpStatus: 'http_status',
  /** The secret could not be opened (`APP_ENCRYPTION_KEY` missing or changed). */
  secretUnavailable: 'secret_unavailable',
} as const;
export type WebhookAttemptError =
  (typeof WEBHOOK_ATTEMPT_ERRORS)[keyof typeof WEBHOOK_ATTEMPT_ERRORS];

// ─── Errors ─────────────────────────────────────────────────────────────────

/** Stable codes in the `error` field of a webhooks route's error body. */
export const WEBHOOKS_ERROR = {
  notFound: 'not_found',
  /** D2: this delivery id was already received for the trigger. */
  replayed: 'replayed',
  /** D4: the payload does not render the trigger's args. */
  invalidPayload: 'invalid_payload',
  /** D4: the args template or `allowedPaths` is not valid (create / update). */
  invalidTemplate: 'invalid_template',
  /** D6. */
  rateLimited: 'rate_limited',
  /** D15. */
  blockedAddress: 'blocked_address',
  /** D15. */
  httpsRequired: 'https_required',
  /** Not an absolute `http(s)` URL, or it carries credentials. */
  invalidUrl: 'invalid_url',
  /** D15: the host does not resolve. */
  unresolvable: 'unresolvable',
  /** D17 (#22). */
  encryptionKeyMissing: 'encryption_key_missing',
  /** An `allowedPrivateTargets` entry is neither a host name nor an IP/CIDR. */
  invalidTarget: 'invalid_target',
} as const;
export type WebhooksErrorCode =
  (typeof WEBHOOKS_ERROR)[keyof typeof WEBHOOKS_ERROR];

export interface WebhooksErrorBody {
  statusCode: number;
  error: WebhooksErrorCode;
  message: string;
  /** D4: why the payload or template was refused, and at which path. */
  reason?: InboundTemplateError;
  path?: string;
}

// ─── Inbound: public route (D1–D7) ──────────────────────────────────────────

/** `POST /hooks/:publicId` → 202. */
export interface InboundHookAccepted {
  /** The caller's `X-AgentDock-Delivery`. */
  deliveryId: string;
  status: InboundDeliveryStatus;
}

// ─── Inbound: admin API ─────────────────────────────────────────────────────

/** `POST /admin/triggers` body. */
export interface InboundTriggerCreateRequest {
  name: string;
  projectId: string;
  action: InboundTriggerAction;
  allowedPaths: string[];
  /** Null or absent: `DEFAULT_INBOUND_VALUE_PATTERN`. */
  valuePattern?: string | null;
}

/** `PATCH /admin/triggers/:id` body; the project is fixed at create. */
export interface InboundTriggerUpdateRequest {
  name?: string;
  action?: InboundTriggerAction;
  allowedPaths?: string[];
  valuePattern?: string | null;
  enabled?: boolean;
}

/** One trigger as the admin API returns it. Never carries a secret. */
export interface InboundTriggerView {
  id: string;
  publicId: string;
  /** `/hooks/<publicId>`, relative to the API's public URL. */
  path: string;
  name: string;
  projectId: string;
  action: InboundTriggerAction;
  allowedPaths: string[];
  valuePattern: string | null;
  enabled: boolean;
  disabledReason: string | null;
  /** The previous secret still verifies until then (D17); null otherwise. */
  previousSecretUntil: string | null;
  createdById: string | null;
  createdAt: string;
  updatedAt: string;
  lastDelivery: { status: InboundDeliveryStatus; receivedAt: string } | null;
}

/** One inbound delivery in a trigger's log. */
export interface InboundDeliveryView {
  /** BigInt in the database — a decimal string here. */
  id: string;
  deliveryId: string;
  receivedAt: string;
  status: InboundDeliveryStatus;
  reason: string | null;
  renderedArgs: unknown;
  runId: string | null;
  commandRunId: string | null;
  sourceIp: string | null;
}

/** `GET /admin/triggers/:id`: the trigger and its last 100 deliveries. */
export interface InboundTriggerDetail extends InboundTriggerView {
  deliveries: InboundDeliveryView[];
}

/** Deliveries `GET /admin/triggers/:id` includes. */
export const INBOUND_DETAIL_DELIVERIES = 100;

/** `POST /admin/triggers` and `…/rotate-secret`: the secret, shown once (D17). */
export interface InboundTriggerWithSecret extends InboundTriggerView {
  secret: string;
}

/** `POST /admin/triggers/:id/dry-run` body. */
export interface InboundDryRunRequest {
  payload: unknown;
}

/** The dry run's verdict — the same as the hook's, nothing fires. */
export type InboundDryRunResult =
  | { ok: true; args: string | null }
  | {
      ok: false;
      error: typeof WEBHOOKS_ERROR.invalidPayload;
      reason: InboundTemplateError;
      path?: string;
    };

// ─── Outbound: admin API ────────────────────────────────────────────────────

/** `POST /admin/webhooks` body. `projectIds` empty: every project. */
export interface WebhookCreateRequest {
  name: string;
  url: string;
  events: WebhookEventType[];
  projectIds: string[];
}

/** `PATCH /admin/webhooks/:id` body. */
export interface WebhookUpdateRequest {
  name?: string;
  url?: string;
  events?: WebhookEventType[];
  projectIds?: string[];
  enabled?: boolean;
}

/** One webhook as the admin API returns it. Never carries the secret. */
export interface WebhookView {
  id: string;
  name: string;
  url: string;
  events: WebhookEventType[];
  projectIds: string[];
  enabled: boolean;
  circuitState: WebhookCircuitState;
  circuitOpenedAt: string | null;
  consecutiveFailures: number;
  createdById: string | null;
  createdAt: string;
  updatedAt: string;
  lastDelivery: {
    status: WebhookDeliveryStatus;
    createdAt: string;
    responseCode: number | null;
  } | null;
}

/** `POST /admin/webhooks` and `…/rotate-secret`: the secret, shown once (D17). */
export interface WebhookWithSecret extends WebhookView {
  secret: string;
}

/** One outbound delivery in a webhook's log. */
export interface WebhookDeliveryView {
  id: string;
  webhookId: string;
  /** `events.id` as a decimal string; null for `webhook.test`. */
  eventId: string | null;
  eventType: WebhookEventType;
  payload: WebhookEnvelope;
  status: WebhookDeliveryStatus;
  attempts: number;
  nextAttemptAt: string;
  lastAttemptAt: string | null;
  responseCode: number | null;
  responseBody: string | null;
  error: string | null;
  createdAt: string;
}

/** `GET /admin/webhooks/:id/deliveries?status=&cursor=`. */
export interface WebhookDeliveryPage {
  items: WebhookDeliveryView[];
  /** Pass as `cursor` for the next (older) page; null on the last page. */
  nextCursor: string | null;
}

export const WEBHOOK_DELIVERY_PAGE_SIZE = 50;

// ─── Outbound: settings (D15) ───────────────────────────────────────────────

/** `settings` key: hosts and CIDRs an outbound webhook may reach although private. */
export const WEBHOOKS_ALLOWED_PRIVATE_TARGETS_KEY =
  'webhooks.allowedPrivateTargets';
/** Most entries in `allowedPrivateTargets`. */
export const WEBHOOKS_ALLOWED_PRIVATE_TARGETS_MAX = 100;

/** `GET` / `PUT /admin/settings/webhooks`. */
export interface WebhookSettingsView {
  allowedPrivateTargets: string[];
}

const HOST_NAME =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const IPV4 =
  /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
const IPV6 = /^[0-9a-f:.]{2,45}$/;

/**
 * An `allowedPrivateTargets` entry, lower-cased and trimmed, or null when it
 * is neither a host name, an IP address nor a CIDR. The API re-checks IPv6
 * entries with `net` before storing them.
 */
export const normalizeAllowedTarget = (entry: string): string | null => {
  const value = entry.trim().toLowerCase();
  const slash = value.indexOf('/');
  if (slash >= 0) {
    const address = value.slice(0, slash);
    const bits = value.slice(slash + 1);
    if (!/^\d{1,3}$/.test(bits)) return null;
    const prefix = Number(bits);
    if (IPV4.test(address)) return prefix <= 32 ? value : null;
    if (address.includes(':') && IPV6.test(address))
      return prefix <= 128 ? value : null;
    return null;
  }
  if (IPV4.test(value)) return value;
  if (value.includes(':')) return IPV6.test(value) ? value : null;
  // All-numeric labels are a mistyped address, not a name.
  if (/^[\d.]+$/.test(value)) return null;
  return HOST_NAME.test(value) ? value : null;
};

// ─── Live (D20) ─────────────────────────────────────────────────────────────

/** Event types published on the `admin` topic. */
export const WEBHOOK_LIVE_EVENTS = {
  deliveryUpdated: 'webhook_delivery.updated',
  inboundDeliveryCreated: 'inbound_delivery.created',
} as const;

/** `webhook_delivery.updated` data. */
export interface WebhookDeliveryUpdatedData {
  webhookId: string;
  deliveryId: string;
  status: WebhookDeliveryStatus;
  attempts: number;
  responseCode: number | null;
  nextAttemptAt: string;
  circuitState: WebhookCircuitState;
}

/** `inbound_delivery.created` data. */
export interface InboundDeliveryCreatedData {
  triggerId: string;
  id: string;
  deliveryId: string;
  status: InboundDeliveryStatus;
  reason: string | null;
}

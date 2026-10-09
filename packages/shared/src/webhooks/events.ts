/**
 * The outbound event catalogue (docs/specs/26-webhooks.md D9) and the fixed
 * envelope a delivery carries (D10). Closed on purpose: an event type reaches
 * a receiver only if it is listed here, and only the keys its builder copies.
 * `llm.request`, `tool.call` and pane text have no entry, so they cannot be
 * sent.
 */
export const WEBHOOK_EVENT_TYPES = [
  'orchestrator.started',
  'orchestrator.stopped',
  'slot.dispatched',
  'slot.checkpoint',
  'slot.stopped',
  'pr.opened',
  'pr.checks_changed',
  'pr.merged',
  'pr.closed',
  'issue.blocked',
  'person.needed',
  'pane.prompt',
  'pane.quota_hit',
  'schedule.failed',
  'schedule.disabled',
  'webhook.test',
] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

const EVENT_TYPE_SET: ReadonlySet<string> = new Set(WEBHOOK_EVENT_TYPES);

export const isWebhookEventType = (type: string): type is WebhookEventType =>
  EVENT_TYPE_SET.has(type);

/** D10: `slot.checkpoint`'s `summary` is cut to this many characters. */
export const WEBHOOK_SUMMARY_MAX_CHARS = 1000;
/** Any other copied string is cut to this many characters. */
export const WEBHOOK_STRING_MAX_CHARS = 500;

/** A value the envelope's `data` may hold: primitives and one level of object. */
export type WebhookDataValue =
  | string
  | number
  | boolean
  | { [key: string]: string | number | boolean };

export type WebhookEventData = { [key: string]: WebhookDataValue };

/** D10: the body of every outbound delivery. */
export interface WebhookEnvelope {
  /** Stable per event: `evt_<events.id>`, or `test_<delivery id>` for `webhook.test`. */
  id: string;
  type: WebhookEventType;
  /** ISO 8601. */
  ts: string;
  project: { id: string; repo: string } | null;
  slot?: string;
  issue?: number;
  data: WebhookEventData;
}

/** What the envelope is built from: an `events` row, or a synthetic test. */
export interface WebhookEnvelopeSource {
  id: string;
  type: string;
  ts: Date | string;
  project: { id: string; repo: string } | null;
  slot?: string | null;
  issue?: number | null;
  data: unknown;
}

type Raw = Record<string, unknown>;

const asRecord = (value: unknown): Raw =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Raw)
    : {};

const text = (raw: Raw, key: string, max = WEBHOOK_STRING_MAX_CHARS) => {
  const value = raw[key];
  return typeof value === 'string' ? value.slice(0, max) : undefined;
};

const int = (raw: Raw, key: string) => {
  const value = raw[key];
  return typeof value === 'number' && Number.isSafeInteger(value)
    ? value
    : undefined;
};

const flag = (raw: Raw, key: string) => {
  const value = raw[key];
  return typeof value === 'boolean' ? value : undefined;
};

/** Drops the keys whose value was absent or of the wrong type. */
const compact = (
  entries: Record<string, WebhookDataValue | undefined>,
): WebhookEventData => {
  const out: WebhookEventData = {};
  for (const [key, value] of Object.entries(entries)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
};

/** `pr` of a checkpoint: `{ number?, url? }`, or nothing when neither is set. */
const checkpointPr = (raw: Raw) => {
  const pr = compact({
    number: int(raw, 'prNumber') ?? int(raw, 'pr'),
    url: text(raw, 'prUrl') ?? text(raw, 'url'),
  }) as { [key: string]: number | string };
  return Object.keys(pr).length > 0 ? pr : undefined;
};

/**
 * D10: per type, the only keys copied from an event's `data` — never the raw
 * object. Strings are cut, objects and arrays other than the ones built here
 * are dropped, filesystem paths are never copied.
 */
const DATA_BUILDERS: Record<WebhookEventType, (raw: Raw) => WebhookEventData> =
  {
    'orchestrator.started': (raw) => compact({ session: text(raw, 'session') }),
    'orchestrator.stopped': (raw) =>
      compact({ session: text(raw, 'session'), reason: text(raw, 'reason') }),
    'slot.dispatched': (raw) =>
      compact({
        branch: text(raw, 'branch'),
        runtime: text(raw, 'runtime'),
        model: text(raw, 'model'),
        lead: flag(raw, 'lead'),
      }),
    'slot.checkpoint': (raw) =>
      compact({
        checkpoint: text(raw, 'checkpoint'),
        summary: text(raw, 'summary', WEBHOOK_SUMMARY_MAX_CHARS),
        pr: checkpointPr(raw),
      }),
    'slot.stopped': (raw) => compact({ by: text(raw, 'by') }),
    'pr.opened': (raw) =>
      compact({
        number: int(raw, 'number'),
        branch: text(raw, 'branch'),
        url: text(raw, 'url'),
        title: text(raw, 'title'),
        checks: text(raw, 'checks'),
        mergeable: flag(raw, 'mergeable'),
      }),
    'pr.checks_changed': (raw) =>
      compact({
        number: int(raw, 'number'),
        branch: text(raw, 'branch'),
        checks: text(raw, 'checks'),
        mergeable: flag(raw, 'mergeable'),
      }),
    'pr.merged': (raw) =>
      compact({
        number: int(raw, 'number'),
        branch: text(raw, 'branch'),
        method: text(raw, 'method'),
      }),
    'pr.closed': (raw) =>
      compact({
        number: int(raw, 'number'),
        branch: text(raw, 'branch'),
        merged: flag(raw, 'merged'),
      }),
    'issue.blocked': (raw) =>
      compact({
        kind: text(raw, 'kind'),
        why: text(raw, 'why', WEBHOOK_SUMMARY_MAX_CHARS),
      }),
    'person.needed': (raw) =>
      compact({
        question: text(raw, 'question', WEBHOOK_SUMMARY_MAX_CHARS),
        recommendation: text(raw, 'recommendation', WEBHOOK_SUMMARY_MAX_CHARS),
      }),
    'pane.prompt': (raw) => compact({ dialog: text(raw, 'dialog') }),
    'pane.quota_hit': () => ({}),
    'schedule.failed': (raw) =>
      compact({
        scheduleId: text(raw, 'scheduleId'),
        name: text(raw, 'name'),
        reason: text(raw, 'reason'),
      }),
    'schedule.disabled': (raw) =>
      compact({
        scheduleId: text(raw, 'scheduleId'),
        name: text(raw, 'name'),
        reason: text(raw, 'reason'),
      }),
    'webhook.test': (raw) => compact({ message: text(raw, 'message') }),
  };

/**
 * D10: the envelope for one event, or null when its type is not in the
 * catalogue — the dispatcher sends nothing for it.
 */
export const buildWebhookEnvelope = (
  source: WebhookEnvelopeSource,
): WebhookEnvelope | null => {
  if (!isWebhookEventType(source.type)) return null;
  const envelope: WebhookEnvelope = {
    id: source.id,
    type: source.type,
    ts: typeof source.ts === 'string' ? source.ts : source.ts.toISOString(),
    project: source.project
      ? { id: source.project.id, repo: source.project.repo }
      : null,
    data: DATA_BUILDERS[source.type](asRecord(source.data)),
  };
  if (source.slot) envelope.slot = source.slot;
  if (typeof source.issue === 'number') envelope.issue = source.issue;
  return envelope;
};

/** `id` of an envelope built from an `events` row. */
export const webhookEnvelopeId = (eventId: bigint | number | string): string =>
  `evt_${eventId}`;

import {
  EVENT_SCHEMA_VERSION,
  type EventsUnparsedData,
  PLUGIN_EVENT_ID_KEY,
  type RoundDecisions,
  slotRuntimeSchema,
  UNPARSED_LINE_MAX,
  type UnsequencedEvent,
  unsequencedEventSchema,
} from '../protocol';

/**
 * Code Sentinel's `events.jsonl` (spec 16, plugin `EVENTS.md`) → AgentDock's
 * envelope. The plugin writes the event-schema.md type names, but not every
 * `data` shape: this is the one place that maps them, for the runner's
 * `events` collector to call per line before it assigns `seq`.
 */

/** The watched project an `events.jsonl` belongs to — it is authoritative. */
export interface CodeSentinelProject {
  repo: string;
  root: string;
}

export type CodeSentinelLine =
  | { ok: true; event: UnsequencedEvent }
  | { ok: false; reason: string };

type Data = Record<string, unknown>;

const isObject = (value: unknown): value is Data =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** `emit.py`'s `key=value` is always a string; `key:=` is typed. Accept both. */
const int = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return undefined;
};

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

const isUrl = (value: string): boolean => {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
};

/** `<…>/<YYYY-MM-DD>/round-<HHMM>.md`, the board path the orchestrator writes. */
const BOARD_DATE = /(\d{4}-\d{2}-\d{2})\/round-\d{4}\.md$/;

/** `round.decided` row states → the board table each would sit in. */
const DECISION_TABLE: Record<string, keyof RoundDecisions> = {
  READY: 'dispatching',
  IN_FLIGHT: 'inFlight',
  BLOCKED_WORK: 'notDispatching',
  BLOCKED_PERSON: 'notDispatching',
  NO_SPEC: 'notDispatching',
};

const CHECKPOINTS = new Set([
  'picked_up',
  'plan_ready',
  'implementation_done',
  'pr_open',
  'blocked',
  'misclassified',
]);

const decisionsOf = (rows: unknown): RoundDecisions => {
  const decisions: RoundDecisions = {
    dispatching: [],
    heldForLead: [],
    notDispatching: [],
    inFlight: [],
  };
  if (!Array.isArray(rows)) return decisions;
  for (const row of rows) {
    if (!isObject(row)) continue;
    const state = typeof row.state === 'string' ? row.state : '';
    const cells: Record<string, string> = {};
    for (const [key, value] of Object.entries(row)) {
      if (value === null || value === undefined) continue;
      const cell = typeof value === 'string' ? value : JSON.stringify(value);
      cells[key.charAt(0).toUpperCase() + key.slice(1)] =
        key === 'issue' && int(value) !== undefined ? `#${int(value)}` : cell;
    }
    decisions[DECISION_TABLE[state] ?? 'notDispatching'].push(cells);
  }
  return decisions;
};

/**
 * The fleet `data` for a plugin type whose shape differs from event-schema.md's
 * Fleet table. The plugin's own keys are kept beside the mapped ones — the
 * fleet schemas drop what they do not know, the `events` table keeps it raw.
 * Types not listed here are forwarded as written (D4).
 */
const MAPPERS: Record<string, (data: Data, ts: string) => Data> = {
  'slot.dispatched': (data) => ({
    briefPath: text(data.brief),
    runtime: slotRuntimeSchema.safeParse(data.runtime).success
      ? data.runtime
      : 'claude',
    lead:
      typeof data.lead === 'boolean'
        ? data.lead
        : data.lead === 'true'
          ? true
          : data.lead === 'false'
            ? false
            : undefined,
  }),
  'round.started': (data, ts) => {
    const board = text(data.board);
    return {
      date: board?.match(BOARD_DATE)?.[1] ?? ts.slice(0, 10),
      round: data.round,
      occupied: int(data.occupied),
      max: int(data.max),
      free: int(data.free),
      boardPath: board,
    };
  },
  'round.decided': (data) => ({ decisions: decisionsOf(data.rows) }),
  'slot.checkpoint': (data) => {
    const kind = text(data.checkpoint) ?? 'other';
    const url = text(data.url);
    return {
      checkpoint: CHECKPOINTS.has(kind) ? kind : 'other',
      ...(CHECKPOINTS.has(kind) ? {} : { heading: kind.slice(0, 500) }),
      summary: typeof data.summary === 'string' ? data.summary : '',
      prUrl: url && isUrl(url) ? url : undefined,
      prNumber: int(data.pr),
    };
  },
  'pr.checks_changed': (data) => ({
    number: int(data.pr),
    checks: data.rollup,
  }),
  'pr.closed': (data) => ({ number: int(data.pr) }),
  'pr.merged': (data) => ({ number: int(data.pr) }),
};

/** Drops `undefined` values, so a mapped key the plugin did not send stays absent. */
const defined = (data: Data): Data =>
  Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined));

/**
 * One line of `events.jsonl` (without its `\n`) → an event for the API, or the
 * reason it is `events.unparsed` (spec 16 D3). The runner assigns `seq`.
 *
 * - `v` must be `EVENT_SCHEMA_VERSION`; `type`, `ts` and `eid` must be there.
 * - `source` becomes `code-sentinel`; `project` is the watched project (the
 *   plugin's `repo` can be null); the plugin's `session` (no `id`) is dropped.
 * - `eid` is kept as `data.pluginEventId`, the API's dedupe key (D5).
 */
export const normalizeCodeSentinelLine = (
  line: string,
  project: CodeSentinelProject,
): CodeSentinelLine => {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return { ok: false, reason: 'malformed JSON' };
  }
  if (!isObject(raw)) return { ok: false, reason: 'not a JSON object' };
  if (raw.v !== EVENT_SCHEMA_VERSION) {
    return {
      ok: false,
      reason: `unsupported schema version ${JSON.stringify(raw.v ?? null)}`,
    };
  }
  const type = text(raw.type);
  if (!type) return { ok: false, reason: 'missing type' };
  const eid = text(raw.eid);
  if (!eid) return { ok: false, reason: 'missing eid' };
  if (typeof raw.ts !== 'string') return { ok: false, reason: 'missing ts' };

  const data = isObject(raw.data) ? raw.data : {};
  const mapped = MAPPERS[type]?.(data, raw.ts) ?? {};
  const slot = text(raw.slot);
  const issue = int(raw.issue);
  const parsed = unsequencedEventSchema.safeParse({
    v: EVENT_SCHEMA_VERSION,
    ts: raw.ts,
    type,
    source: 'code-sentinel',
    project: { repo: project.repo, root: project.root },
    ...(slot ? { slot } : {}),
    ...(issue && issue > 0 ? { issue } : {}),
    data: defined({ ...data, ...mapped, [PLUGIN_EVENT_ID_KEY]: eid }),
  });
  if (!parsed.success) {
    return { ok: false, reason: parsed.error.issues[0]?.message ?? 'invalid' };
  }
  return { ok: true, event: parsed.data };
};

/** `data` of the `events.unparsed` the runner emits for a rejected line. */
export const eventsUnparsedData = (
  file: string,
  line: string,
  reason: string,
  offset?: number,
): EventsUnparsedData => ({
  file,
  line: line.slice(0, UNPARSED_LINE_MAX),
  ...(offset !== undefined ? { offset } : {}),
  reason: reason.slice(0, 500),
});

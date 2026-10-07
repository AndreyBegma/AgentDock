import { z } from 'zod';
import type { RunnerEvent } from '../envelope';

/**
 * Fleet events (spec 11 D7): what the runner's collectors observe about a
 * project's orchestrator, slots, rounds and pull requests. Slot-scoped events
 * name the slot in the envelope's `slot` and its issue in `issue`; `data`
 * never repeats them.
 *
 * Events derived from markdown (boards, briefs, reply files) carry
 * `source: "scraped"` (ADR-0002); events from tmux, git and `gh` carry
 * `source: "runner"`.
 */

/** `YYYY-MM-DD`, the board's directory name. */
export const roundDateSchema = z.iso.date();
/** `HHMM`, from `round-<HHMM>.md`. */
export const roundLabelSchema = z.string().regex(/^\d{4}$/, 'must be HHMM');

const count = z.number().int().nonnegative();
const glob = z.string().min(1);

/** A tmux `cs-*` session appeared or vanished (D1). */
export const sessionPresenceDataSchema = z.object({
  /** The tmux session name, e.g. `cs-i42-api`. */
  name: z.string().min(1),
  pid: z.number().int().positive().optional(),
});
export type SessionPresenceData = z.infer<typeof sessionPresenceDataSchema>;

/** Whose pane a `pane.*` event is about: a slot's or the orchestrator's. */
export const paneTargetSchema = z.enum(['slot', 'orchestrator']);
export type PaneTarget = z.infer<typeof paneTargetSchema>;

const paneFields = { target: paneTargetSchema.default('slot') };

/** The dialogs `watch.sh` recognises on a launch (D2). */
export const paneDialogSchema = z.enum([
  'trust',
  'bypass',
  'credits',
  'settings',
  'other',
]);
export type PaneDialog = z.infer<typeof paneDialogSchema>;

/** A launch dialog waits for a key. */
export const panePromptDataSchema = z.object({
  ...paneFields,
  dialog: paneDialogSchema.default('other'),
});
/** The pane shows an empty prompt for `polls` consecutive polls. */
export const paneIdleDataSchema = z.object({
  ...paneFields,
  polls: z.number().int().positive(),
});
/** The quota banner (`hit your weekly limit`) is on screen. */
export const paneQuotaDataSchema = z.object(paneFields);
/** `esc to interrupt` is on screen again: the pane left idle, prompt or quota. */
export const paneBusyDataSchema = z.object(paneFields);

/** A slot's `.wt-<repo>-<slot>` worktree as git sees it (D1, D8). */
export const worktreeChangedDataSchema = z.object({
  path: z.string().min(1),
  /** `false` once the directory is gone. The other fields are then absent. */
  exists: z.boolean(),
  branch: z.string().min(1).optional(),
  /** Commits on the branch that are not on the base. */
  ahead: count.optional(),
  behind: count.optional(),
  dirty: z.boolean().optional(),
});
export type WorktreeChangedData = z.infer<typeof worktreeChangedDataSchema>;

/** The header line of `round-<HHMM>.md` (D4). */
export const roundStartedDataSchema = z.object({
  date: roundDateSchema,
  round: roundLabelSchema,
  base: z.string().min(1),
  occupied: count,
  max: count,
  free: count,
  /** Absolute path of the board file. */
  boardPath: z.string().min(1),
});
export type RoundStartedData = z.infer<typeof roundStartedDataSchema>;

/** A board table row, keyed by its column header as written. Unknown columns are kept raw. */
export const boardRowSchema = z.record(z.string(), z.string());
export type BoardRow = z.infer<typeof boardRowSchema>;

/** The four tables of a board (orchestrator Phase 5). A missing table is `[]`. */
export const roundDecisionsSchema = z.object({
  dispatching: z.array(boardRowSchema).default([]),
  heldForLead: z.array(boardRowSchema).default([]),
  notDispatching: z.array(boardRowSchema).default([]),
  inFlight: z.array(boardRowSchema).default([]),
});
export type RoundDecisions = z.infer<typeof roundDecisionsSchema>;

export const roundDecidedDataSchema = z.object({
  date: roundDateSchema,
  round: roundLabelSchema,
  decisions: roundDecisionsSchema,
});
export type RoundDecidedData = z.infer<typeof roundDecidedDataSchema>;

/** A board or brief that could not be parsed. Never fatal for the runner (D4). */
export const boardUnparsedDataSchema = z.object({
  file: z.string().min(1),
  /** 1-based line the parser stopped at, when it knows one. */
  line: z.number().int().positive().optional(),
  reason: z.string().min(1).max(500),
});
export type BoardUnparsedData = z.infer<typeof boardUnparsedDataSchema>;

export const slotRuntimeSchema = z.enum(['claude', 'codex']);
export type SlotRuntime = z.infer<typeof slotRuntimeSchema>;

/** A brief `round-<HHMM>-<slot>.md` (D4). */
export const slotDispatchedDataSchema = z.object({
  date: roundDateSchema,
  round: roundLabelSchema,
  briefPath: z.string().min(1),
  branch: z.string().min(1).optional(),
  worktree: z.string().min(1).optional(),
  runtime: slotRuntimeSchema.default('claude'),
  model: z.string().min(1).optional(),
  /** The reason on the brief's `Model:` line. */
  modelWhy: z.string().min(1).optional(),
  owns: z.array(glob).default([]),
  never: z.array(glob).default([]),
  lead: z.boolean().optional(),
});
export type SlotDispatchedData = z.infer<typeof slotDispatchedDataSchema>;

/** The `##` checkpoints a worker writes to `.orchestrator-reply.md` (D5). */
export const CHECKPOINT_KINDS = [
  'picked_up',
  'plan_ready',
  'implementation_done',
  'pr_open',
  'blocked',
  'misclassified',
  'other',
] as const;
export const checkpointKindSchema = z.enum(CHECKPOINT_KINDS);
export type CheckpointKind = z.infer<typeof checkpointKindSchema>;

/** Largest `summary` of a checkpoint, in bytes (D5). */
export const CHECKPOINT_SUMMARY_MAX_BYTES = 4096;

export const slotCheckpointDataSchema = z.object({
  checkpoint: checkpointKindSchema,
  /** The heading as written, without `## `. */
  heading: z.string().min(1).max(500),
  /** The body under the heading, trimmed to `CHECKPOINT_SUMMARY_MAX_BYTES`. */
  summary: z.string().default(''),
  /**
   * 0-based index of the heading among the file's `##` headings. The file is
   * append-only and has no timestamps, so this identifies a checkpoint across
   * rescans and runner restarts.
   */
  position: z.number().int().nonnegative(),
  /** With `pr_open`: the URL from `pull request open — <url>`. */
  prUrl: z.url().optional(),
});
export type SlotCheckpointData = z.infer<typeof slotCheckpointDataSchema>;

/** Rolled-up checks of a pull request (D3). */
export const prChecksSchema = z.enum(['pending', 'green', 'red']);
export type PrChecks = z.infer<typeof prChecksSchema>;

const prFields = {
  number: z.number().int().positive(),
  /** `headRefName`; matches the slot's branch. */
  branch: z.string().min(1),
};

export const prOpenedDataSchema = z.object({
  ...prFields,
  url: z.url(),
  title: z.string(),
  checks: prChecksSchema,
  /** `MERGEABLE` → true, `CONFLICTING` → false, `UNKNOWN` → absent. */
  mergeable: z.boolean().optional(),
});
export type PrOpenedData = z.infer<typeof prOpenedDataSchema>;

export const prChecksChangedDataSchema = z.object({
  ...prFields,
  checks: prChecksSchema,
  mergeable: z.boolean().optional(),
});
export type PrChecksChangedData = z.infer<typeof prChecksChangedDataSchema>;

export const prClosedDataSchema = z.object({
  ...prFields,
  merged: z.boolean(),
});
export type PrClosedData = z.infer<typeof prClosedDataSchema>;

/** The orchestrator's tmux pane appeared in the project root (D6). */
export const orchestratorStartedDataSchema = z.object({
  /** The tmux session it runs in. */
  session: z.string().min(1),
});
export type OrchestratorStartedData = z.infer<
  typeof orchestratorStartedDataSchema
>;

export const orchestratorStoppedDataSchema = z.object({
  session: z.string().min(1),
  reason: z.string().max(500).optional(),
});
export type OrchestratorStoppedData = z.infer<
  typeof orchestratorStoppedDataSchema
>;

/** A commit on a slot's branch carries an agent trailer. */
export const commitTrailerFoundDataSchema = z.object({
  sha: z.string().regex(/^[0-9a-f]{7,64}$/),
});

/** `data` schema of every fleet event type. */
export const fleetEventDataSchemas = {
  'session.appeared': sessionPresenceDataSchema,
  'session.vanished': sessionPresenceDataSchema,
  'pane.prompt': panePromptDataSchema,
  'pane.idle': paneIdleDataSchema,
  'pane.quota_hit': paneQuotaDataSchema,
  'pane.busy': paneBusyDataSchema,
  'worktree.changed': worktreeChangedDataSchema,
  'round.started': roundStartedDataSchema,
  'round.decided': roundDecidedDataSchema,
  'board.unparsed': boardUnparsedDataSchema,
  'slot.dispatched': slotDispatchedDataSchema,
  'slot.checkpoint': slotCheckpointDataSchema,
  'pr.opened': prOpenedDataSchema,
  'pr.checks_changed': prChecksChangedDataSchema,
  'pr.closed': prClosedDataSchema,
  'orchestrator.started': orchestratorStartedDataSchema,
  'orchestrator.stopped': orchestratorStoppedDataSchema,
  'commit.trailer_found': commitTrailerFoundDataSchema,
} as const;

export type FleetEventType = keyof typeof fleetEventDataSchemas;
export const FLEET_EVENT_TYPES = Object.keys(
  fleetEventDataSchemas,
) as FleetEventType[];

/** Event types whose envelope must name a `slot`. */
export const SLOT_SCOPED_FLEET_EVENTS: readonly FleetEventType[] = [
  'session.appeared',
  'session.vanished',
  'worktree.changed',
  'slot.dispatched',
  'slot.checkpoint',
  'commit.trailer_found',
];

type FleetDataOf<T extends FleetEventType> = z.output<
  (typeof fleetEventDataSchemas)[T]
>;

/** A fleet event whose `data` has been parsed for its type. */
export type FleetEvent = {
  [T in FleetEventType]: Omit<RunnerEvent, 'type' | 'data'> & {
    type: T;
    data: FleetDataOf<T>;
  };
}[FleetEventType];

export const isFleetEventType = (type: string): type is FleetEventType =>
  Object.hasOwn(fleetEventDataSchemas, type);

export type FleetEventParse =
  | { ok: true; event: FleetEvent }
  | { ok: false; reason: string };

/**
 * Parses the `data` of a fleet event. `null` for a type that is not a fleet
 * event; `ok: false` for a fleet event whose `data` or envelope does not fit.
 */
export const parseFleetEvent = (event: RunnerEvent): FleetEventParse | null => {
  if (!isFleetEventType(event.type)) return null;
  const type = event.type;
  if (SLOT_SCOPED_FLEET_EVENTS.includes(type) && !event.slot) {
    return { ok: false, reason: `${type} without an envelope slot` };
  }
  const parsed = fleetEventDataSchemas[type].safeParse(event.data);
  if (!parsed.success) {
    return { ok: false, reason: `${type}: ${parsed.error.message}` };
  }
  const target = (parsed.data as { target?: PaneTarget }).target;
  if (target === 'slot' && !event.slot) {
    return { ok: false, reason: `${type} for a slot without an envelope slot` };
  }
  return {
    ok: true,
    event: { ...event, type, data: parsed.data } as FleetEvent,
  };
};

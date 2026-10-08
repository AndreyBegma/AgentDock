import type { EventSource } from '@agentdock/shared/protocol';
import type { Prisma } from '@prisma/client';

/**
 * Field groups of a slot and a round, and which source last wrote each
 * (spec 16 D7). Stored in the rows' `sources` Json.
 */
export type SlotGroup = 'model' | 'checkpoint' | 'pr';
export type RoundGroup = 'header' | 'decisions';

export interface SlotSources extends Partial<Record<SlotGroup, EventSource>> {
  /** `ts` of the plugin `slot.dispatched` (or snapshot) that started this run (Q3). */
  dispatchedAt?: string;
  /** Lowest reply position a plugin checkpoint may still claim. */
  checkpoints?: number;
}
export type RoundSources = Partial<Record<RoundGroup, EventSource>>;

/** The groups the plugin reports; `both` is about these (D8). */
export const PLUGIN_SLOT_GROUPS: readonly SlotGroup[] = [
  'model',
  'checkpoint',
  'pr',
];
export const PLUGIN_ROUND_GROUPS: readonly RoundGroup[] = [
  'header',
  'decisions',
];

export const readSources = <T extends object>(value: Prisma.JsonValue): T =>
  (typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value
    : {}) as T;

/**
 * D7: markdown never overwrites what Code Sentinel reported; Code Sentinel
 * overwrites everything; the runner's own observations (tmux, git, `gh`) are
 * not ranked against either.
 */
export const mayWrite = (
  last: EventSource | undefined,
  source: EventSource,
): boolean => !(source === 'scraped' && last === 'code-sentinel');

/**
 * Drops the fields of every group `source` may not write, and records `source`
 * on every group it does write. Returns the kept patch and the next sources.
 */
export const guardGroups = <G extends string, P extends object>(
  groups: Record<G, readonly (keyof P)[]>,
  sources: Partial<Record<G, EventSource>>,
  source: EventSource,
  patch: P,
): { patch: P; sources: Partial<Record<G, EventSource>> } => {
  const kept = { ...patch };
  const next = { ...sources };
  for (const group of Object.keys(groups) as G[]) {
    const fields = groups[group].filter((f) => kept[f] !== undefined);
    if (fields.length === 0) continue;
    if (mayWrite(sources[group], source)) {
      next[group] = source;
    } else {
      for (const field of fields) delete kept[field];
    }
  }
  return { patch: kept, sources: next };
};

/** True when a plugin-covered group was last written from markdown (D8 `both`). */
export const hasScrapedGroup = (
  sources: Prisma.JsonValue,
  groups: readonly string[],
): boolean => {
  const read = readSources<Record<string, unknown>>(sources);
  return groups.some((group) => read[group] === 'scraped');
};

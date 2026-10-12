import type { ActivityCategory, ActivitySeverity } from './contracts';
import type { ActivityEventSource } from './types';

/**
 * The building blocks of the curated type map (docs/specs/21 D3), shared by
 * `types.ts` and the per-area rule files. Internal to the package.
 */

export type Data = Record<string, unknown>;

export const record = (value: unknown): Data =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Data)
    : {};

export const str = (data: Data, key: string): string | null => {
  const value = data[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
};

export const int = (data: Data, key: string): number | null => {
  const value = data[key];
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return null;
};

/** At most `max` characters, with an ellipsis when cut. */
export const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

export const TITLE_MAX = 200;
export const TEXT_MAX = 500;

export interface EventContext {
  event: ActivityEventSource;
  data: Data;
  /** The envelope slot, else `data.slot`. */
  slot: string | null;
  projectId: string | null;
}

export interface EventRule {
  category: ActivityCategory;
  severity: (ctx: EventContext) => ActivitySeverity;
  title: (ctx: EventContext) => string;
  /** Safe fields kept in `data`. */
  keep: readonly string[];
  /** true: this occurrence is not worth an item. */
  skip?: (ctx: EventContext) => boolean;
  /** The orchestrator, not the runner, is the actor (D5). */
  byOrchestrator?: boolean;
  /** The API itself is the actor: `system` (ADR-0014). */
  bySystem?: boolean;
  /** Only rows of these sources become items; any source when absent. */
  sources?: readonly string[];
  prNumber?: (ctx: EventContext) => number | null;
  link?: (ctx: EventContext) => string | null;
}

export const fixed = (severity: ActivitySeverity) => (): ActivitySeverity =>
  severity;

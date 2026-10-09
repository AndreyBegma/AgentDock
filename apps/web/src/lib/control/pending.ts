import type { CommandRunLiveEvent } from '@agentdock/shared';

/** Runs seen on `project:<id>` that have not finished, keyed by run id. */
export type PendingRuns = Readonly<Record<string, CommandRunLiveEvent>>;

export const NO_PENDING_RUNS: PendingRuns = {};

/**
 * Folds one `command_run.updated` frame in: a `requested` run is pending, any
 * other status removes it. A frame that is not a run is ignored.
 */
export function applyRunEvent(
  pending: PendingRuns,
  run: CommandRunLiveEvent,
): PendingRuns {
  if (run.status === 'requested') return { ...pending, [run.id]: run };
  if (!(run.id in pending)) return pending;
  const { [run.id]: _finished, ...rest } = pending;
  return rest;
}

/** Narrows the untyped `data` of a live frame. */
export function parseRunEvent(data: unknown): CommandRunLiveEvent | null {
  if (typeof data !== 'object' || data === null) return null;
  const run = data as Partial<CommandRunLiveEvent>;
  if (
    typeof run.id !== 'string' ||
    typeof run.command !== 'string' ||
    typeof run.status !== 'string'
  ) {
    return null;
  }
  return run as CommandRunLiveEvent;
}

/** Is a run of `command` (on `slot`, when given) pending? */
export function isPending(
  pending: PendingRuns,
  command: CommandRunLiveEvent['command'],
  slot?: string,
): boolean {
  return Object.values(pending).some(
    (run) =>
      run.command === command && (slot === undefined || run.slot === slot),
  );
}

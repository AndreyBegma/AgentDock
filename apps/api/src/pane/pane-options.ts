/** The pane relay's timings; e2e tests shorten them. */
export interface PaneOptions {
  /**
   * How long a user's watch of a slot outlives their last tab leaving it
   * (C-119). Coming back within it continues the watch: no audit row is
   * written for the leave or the return, so a client looping watch and leave
   * writes one `pane.watch_started`, then one `pane.watch_stopped` once it
   * has been gone this long.
   */
  auditWindowMs: number;
}

export const PANE_OPTIONS = Symbol('PANE_OPTIONS');

export const defaultPaneOptions: PaneOptions = { auditWindowMs: 60_000 };

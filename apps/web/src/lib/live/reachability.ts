/** A blip shorter than this never shows the banner (spec 353 D2). */
export const BANNER_AFTER_MS = 1_500;

export interface ReachabilitySnapshot {
  /** The API (or the live socket) has failed and nothing has succeeded since. */
  unreachable: boolean;
  /** `unreachable` for longer than `BANNER_AFTER_MS`. */
  bannerVisible: boolean;
}

export interface ReachabilityOptions {
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (id: unknown) => void;
}

/**
 * One answer to "can this tab reach the API?" (spec 353 D1). Anything that
 * talks to the server reports a failure or a success; the banner and the
 * live-reconnect refetch read it.
 */
export class Reachability {
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (id: unknown) => void;
  private readonly listeners = new Set<() => void>();
  private timer: unknown = null;
  private snapshot: ReachabilitySnapshot = {
    unreachable: false,
    bannerVisible: false,
  };

  constructor(options: ReachabilityOptions = {}) {
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer =
      options.clearTimer ??
      ((id) => clearTimeout(id as ReturnType<typeof setTimeout>));
  }

  getSnapshot = (): ReachabilitySnapshot => this.snapshot;

  /** For `useSyncExternalStore`. */
  onChange = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  isUnreachable(): boolean {
    return this.snapshot.unreachable;
  }

  markUnreachable(): void {
    if (this.snapshot.unreachable) return;
    this.set({ unreachable: true, bannerVisible: false });
    this.timer = this.setTimer(() => {
      this.timer = null;
      this.set({ unreachable: true, bannerVisible: true });
    }, BANNER_AFTER_MS);
  }

  markReachable(): void {
    if (!this.snapshot.unreachable) return;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    this.set({ unreachable: false, bannerVisible: false });
  }

  private set(next: ReachabilitySnapshot) {
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
}

/** The tab's detector. */
export const reachability = new Reachability();

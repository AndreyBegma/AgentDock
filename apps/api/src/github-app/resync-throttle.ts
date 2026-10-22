export interface ResyncThrottleOptions {
  windowMs: number;
  /** Starts one resync; its failure is the caller's to log. */
  run: () => void;
  setTimer?: (fn: () => void, ms: number) => { cancel: () => void };
  now?: () => number;
}

const defaultTimer = (fn: () => void, ms: number) => {
  const timer = setTimeout(fn, ms);
  timer.unref();
  return { cancel: () => clearTimeout(timer) };
};

/**
 * C-145: delivery-triggered resyncs, at most one per window. The first
 * request runs at once; requests inside the window collapse into one more
 * resync at its end, so a burst of `installation*` deliveries — or replays —
 * costs two listings at most, and the last change is never missed.
 */
export class ResyncThrottle {
  private lastRunAt: number | null = null;
  private trailing: { cancel: () => void } | null = null;
  private readonly setTimer: NonNullable<ResyncThrottleOptions['setTimer']>;
  private readonly now: () => number;

  constructor(private readonly options: ResyncThrottleOptions) {
    this.setTimer = options.setTimer ?? defaultTimer;
    this.now = options.now ?? Date.now;
  }

  request(): void {
    if (this.trailing) return;
    const now = this.now();
    const since =
      this.lastRunAt === null ? Number.POSITIVE_INFINITY : now - this.lastRunAt;
    if (since >= this.options.windowMs) {
      this.fire();
      return;
    }
    this.trailing = this.setTimer(() => {
      this.trailing = null;
      this.fire();
    }, this.options.windowMs - since);
  }

  /** Forgets the window and drops a waiting resync (shutdown, tests). */
  clear(): void {
    this.trailing?.cancel();
    this.trailing = null;
    this.lastRunAt = null;
  }

  private fire(): void {
    this.lastRunAt = this.now();
    this.options.run();
  }
}

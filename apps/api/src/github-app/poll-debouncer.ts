import type { PollableCollector } from '@agentdock/shared/protocol';

/** One poll, as the debouncer hands it out. */
export interface DebouncedPoll {
  projectId: string;
  collectors: PollableCollector[];
}

export interface PollDebouncerOptions {
  windowMs: number;
  /** Sends one poll; its failure is the sender's to log. */
  flush: (poll: DebouncedPoll) => Promise<void>;
  setTimer?: (fn: () => void, ms: number) => { cancel: () => void };
}

const defaultTimer = (fn: () => void, ms: number) => {
  const timer = setTimeout(fn, ms);
  timer.unref();
  return { cancel: () => clearTimeout(timer) };
};

/**
 * D8 (spec notes): polls are debounced per project. The first request opens a
 * fixed window; every request inside it adds its collectors; at the window's
 * end one `collector.poll` carries their union. A burst of deliveries within
 * the window is one poll, sent at most `windowMs` after the first.
 */
export class PollDebouncer {
  private readonly pending = new Map<
    string,
    { collectors: Set<PollableCollector>; cancel: () => void }
  >();
  private readonly inFlight = new Set<Promise<void>>();
  private readonly setTimer: NonNullable<PollDebouncerOptions['setTimer']>;

  constructor(private readonly options: PollDebouncerOptions) {
    this.setTimer = options.setTimer ?? defaultTimer;
  }

  request(projectId: string, collectors: readonly PollableCollector[]): void {
    const open = this.pending.get(projectId);
    if (open) {
      for (const c of collectors) open.collectors.add(c);
      return;
    }
    const entry = {
      collectors: new Set(collectors),
      cancel: () => {},
    };
    this.pending.set(projectId, entry);
    entry.cancel = this.setTimer(
      () => this.fire(projectId),
      this.options.windowMs,
    ).cancel;
  }

  /** Projects with a poll waiting for its window to close. */
  get waiting(): number {
    return this.pending.size;
  }

  /** Sends every waiting poll now and waits for all sends (shutdown, tests). */
  async flushAll(): Promise<void> {
    for (const [projectId, entry] of [...this.pending]) {
      entry.cancel();
      this.fire(projectId);
    }
    await Promise.all([...this.inFlight]);
  }

  /** Drops every waiting poll unsent. */
  clear(): void {
    for (const entry of this.pending.values()) entry.cancel();
    this.pending.clear();
  }

  private fire(projectId: string): void {
    const entry = this.pending.get(projectId);
    if (!entry) return;
    this.pending.delete(projectId);
    const collectors = [...entry.collectors].sort();
    const sent = this.options
      .flush({ projectId, collectors })
      .catch(() => undefined)
      .finally(() => this.inFlight.delete(sent));
    this.inFlight.add(sent);
  }
}

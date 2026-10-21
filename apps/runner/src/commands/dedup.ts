import type { Clock } from '../clock';

/** How many command ids the dispatcher remembers (#740 D3). */
export const DEDUP_CAPACITY = 1_000;
/** How long a command id is remembered after it first arrived (#740 D3). */
export const DEDUP_TTL_MS = 60 * 60 * 1000;

interface Entry<T> {
  value: Promise<T>;
  fingerprint: string;
  at: number;
}

/**
 * How a remembered id was met: `new` ran `start`, `repeated` returned the
 * first run's result, `collision` ran `start` because the id came back with
 * other content — not a resend, so the old result would be the wrong answer.
 */
export type DedupHit = 'new' | 'repeated' | 'collision';

/**
 * An LRU from command id to its in-flight or finished result (#740 D3): a
 * command sent again runs once, and the repeat gets the first one's result.
 * The oldest entry goes when the map is full; an entry older than the TTL is
 * treated as absent.
 */
export class CommandDedup<T> {
  private readonly entries = new Map<string, Entry<T>>();

  constructor(
    private readonly clock: Clock,
    private readonly capacity = DEDUP_CAPACITY,
    private readonly ttlMs = DEDUP_TTL_MS,
  ) {}

  /**
   * The remembered result of `id`, or `start()`'s, remembered from now.
   * `fingerprint` is what the command is (its name and args): a resend has
   * the same one.
   */
  run(
    id: string,
    fingerprint: string,
    start: () => Promise<T>,
  ): { value: Promise<T>; hit: DedupHit } {
    const now = this.clock.now();
    const known = this.entries.get(id);
    const live = known && now - known.at < this.ttlMs ? known : undefined;
    if (live && live.fingerprint === fingerprint) {
      // Most recently used goes last, so eviction takes the least used.
      this.entries.delete(id);
      this.entries.set(id, live);
      return { value: live.value, hit: 'repeated' };
    }
    this.entries.delete(id);
    const value = start();
    this.entries.set(id, { value, fingerprint, at: now });
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
    return { value, hit: live ? 'collision' : 'new' };
  }

  /**
   * Drops `id` while it still holds `value`, so the next command with it runs
   * fresh (a timeout, D5); a newer run under the same id is left alone.
   */
  forget(id: string, value: Promise<T>): void {
    if (this.entries.get(id)?.value === value) this.entries.delete(id);
  }

  get size(): number {
    return this.entries.size;
  }
}

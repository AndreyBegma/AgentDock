/**
 * The runner's concurrency cap for headless runs (spec 24 D11). Skill runs
 * and plan turns (spec 172 "Concurrency") take their slot from one counter,
 * so a skill run waits for a plan turn's slot and a plan turn for a skill
 * run's. Each executor keeps its own queue and pumps again when a slot frees.
 *
 * A leaf module, imported by both executors.
 */
export interface RunSlots {
  /** Takes a slot for `id`; true when it now holds one (also when it already did). */
  tryAcquire(id: string): boolean;
  /** Gives `id`'s slot back; a no-op when it holds none. */
  release(id: string): void;
  /** Called after any slot is released; returns the unsubscribe. */
  onFree(listener: () => void): () => void;
}

export class SharedRunSlots implements RunSlots {
  private readonly held = new Set<string>();
  private readonly listeners = new Set<() => void>();

  constructor(private readonly cap: number) {}

  get inUse(): number {
    return this.held.size;
  }

  tryAcquire(id: string): boolean {
    if (this.held.has(id)) return true;
    if (this.held.size >= this.cap) return false;
    this.held.add(id);
    return true;
  }

  release(id: string): void {
    if (!this.held.delete(id)) return;
    for (const listener of [...this.listeners]) listener();
  }

  onFree(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

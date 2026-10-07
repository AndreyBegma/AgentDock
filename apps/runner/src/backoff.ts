export interface BackoffOptions {
  initialMs?: number;
  maxMs?: number;
  /** Fraction of the delay added or removed at random: 0.2 = ±20 %. */
  jitter?: number;
  /** Returns a number in [0, 1). */
  random?: () => number;
}

/** Reconnect delays: 1 s doubling to 60 s, ±20 % jitter (D6). */
export class Backoff {
  private attempt = 0;
  private readonly initialMs: number;
  private readonly maxMs: number;
  private readonly jitter: number;
  private readonly random: () => number;

  constructor(options: BackoffOptions = {}) {
    this.initialMs = options.initialMs ?? 1_000;
    this.maxMs = options.maxMs ?? 60_000;
    this.jitter = options.jitter ?? 0.2;
    this.random = options.random ?? Math.random;
  }

  next(): number {
    const base = Math.min(this.maxMs, this.initialMs * 2 ** this.attempt);
    if (base < this.maxMs) this.attempt++;
    const factor = 1 + this.jitter * (2 * this.random() - 1);
    return Math.round(base * factor);
  }

  reset(): void {
    this.attempt = 0;
  }
}

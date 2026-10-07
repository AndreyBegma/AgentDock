import type { Cancel, Clock } from '../clock';

interface Timer {
  id: number;
  at: number;
  fn: () => void;
  every: number | null;
}

/** A clock that only moves when a test calls {@link FakeClock.advance}. */
export class FakeClock implements Clock {
  private current: number;
  private nextId = 1;
  private timers: Timer[] = [];

  constructor(start = Date.parse('2026-10-07T18:00:00.000Z')) {
    this.current = start;
  }

  now(): number {
    return this.current;
  }

  setTimeout(fn: () => void, ms: number): Cancel {
    return this.add(fn, ms, null);
  }

  setInterval(fn: () => void, ms: number): Cancel {
    return this.add(fn, ms, Math.max(1, ms));
  }

  /** Delays of the timers still pending, from now, soonest first. */
  pending(): number[] {
    return this.timers.map((t) => t.at - this.current).sort((a, b) => a - b);
  }

  /** Moves time forward, firing every timer that falls due, in order. */
  advance(ms: number): void {
    const target = this.current + ms;
    for (;;) {
      const due = this.timers
        .filter((t) => t.at <= target)
        .sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      this.current = due.at;
      if (due.every === null) {
        this.timers = this.timers.filter((t) => t !== due);
      } else {
        due.at += due.every;
      }
      due.fn();
    }
    this.current = target;
  }

  private add(fn: () => void, ms: number, every: number | null): Cancel {
    const timer: Timer = {
      id: this.nextId++,
      at: this.current + Math.max(0, ms),
      fn,
      every,
    };
    this.timers.push(timer);
    return () => {
      this.timers = this.timers.filter((t) => t !== timer);
    };
  }
}

/** Cancels a timer created by a {@link Clock}. Calling it twice is harmless. */
export type Cancel = () => void;

/** Time and timers, injected so heartbeats, backoff and timeouts are testable. */
export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): Cancel;
  setInterval(fn: () => void, ms: number): Cancel;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const handle = setTimeout(fn, ms);
    return () => clearTimeout(handle);
  },
  setInterval: (fn, ms) => {
    const handle = setInterval(fn, ms);
    return () => clearInterval(handle);
  },
};

export const isoNow = (clock: Clock): string =>
  new Date(clock.now()).toISOString();

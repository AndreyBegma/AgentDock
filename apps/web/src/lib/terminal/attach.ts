/** A socket that has not opened by now is given up on (spec 353 D4). */
export const ATTACH_TIMEOUT_MS = 10_000;
/** After this long without an attach the view stops retrying. */
export const ATTACH_GIVE_UP_MS = 30_000;
const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 8_000;

/** Wait before the nth retry: 0.5, 1, 2, 4, 8 s. */
export const attachRetryDelay = (attempt: number): number =>
  Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt);

/**
 * A close before `attached` with no application code (the proxy dropped it, the
 * API was gone) is worth another try; 4xxx codes are the server's answer.
 */
export const isTransientCloseCode = (code: number): boolean => code < 4000;

export type AttachState =
  | { phase: 'connecting'; attempt: number }
  | { phase: 'reconnecting'; attempt: number }
  | { phase: 'attached'; attempt: number }
  | { phase: 'failed'; attempt: number };

export interface AttachSupervisorOptions {
  /** Starts attempt `n` (1-based): ask for a ticket, open the socket. */
  start: (attempt: number) => void;
  /** Abandons the running attempt: close its socket, ignore its late events. */
  abort: () => void;
  onState: (state: AttachState) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (id: unknown) => void;
}

/**
 * Keeps a terminal attach from sitting on Connecting for ever. An attempt that
 * has not attached within 10 s is abandoned and retried with backoff; 30 s
 * after the first try the supervisor gives up and waits for `retry()`.
 * The view reports `attached()` and `failed()`; everything else is time.
 */
export class AttachSupervisor {
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (id: unknown) => void;
  private attempt = 0;
  private timeout: unknown = null;
  private retryTimer: unknown = null;
  private deadline: unknown = null;
  private done = false;
  private running = false;

  constructor(private readonly options: AttachSupervisorOptions) {
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer =
      options.clearTimer ??
      ((id) => clearTimeout(id as ReturnType<typeof setTimeout>));
  }

  /** First attempt; the 30 s clock starts here. */
  begin(): void {
    this.attempt = 0;
    this.done = false;
    this.deadline = this.setTimer(() => this.giveUp(), ATTACH_GIVE_UP_MS);
    this.startAttempt();
  }

  /** The **Retry** button after `failed`. */
  retry(): void {
    this.stopTimers();
    this.begin();
  }

  /** The `attached` frame arrived. */
  attached(): void {
    if (this.done) return;
    this.running = false;
    this.stopTimers();
    this.options.onState({ phase: 'attached', attempt: this.attempt });
  }

  /** The running attempt failed before it attached (a network error, a close). */
  attemptFailed(): void {
    if (this.done || !this.running) return;
    this.running = false;
    this.clear('timeout');
    this.options.abort();
    this.options.onState({ phase: 'reconnecting', attempt: this.attempt + 1 });
    this.retryTimer = this.setTimer(
      () => {
        this.retryTimer = null;
        this.startAttempt();
      },
      attachRetryDelay(this.attempt - 1),
    );
  }

  /** The view is going away. */
  dispose(): void {
    this.done = true;
    this.stopTimers();
  }

  private startAttempt() {
    this.attempt += 1;
    this.running = true;
    this.options.onState(
      this.attempt === 1
        ? { phase: 'connecting', attempt: 1 }
        : { phase: 'reconnecting', attempt: this.attempt },
    );
    this.timeout = this.setTimer(() => {
      this.timeout = null;
      this.attemptFailed();
    }, ATTACH_TIMEOUT_MS);
    this.options.start(this.attempt);
  }

  private giveUp() {
    this.deadline = null;
    if (this.done) return;
    this.running = false;
    this.stopTimers();
    this.options.abort();
    this.options.onState({ phase: 'failed', attempt: this.attempt });
  }

  private clear(which: 'timeout' | 'retryTimer' | 'deadline') {
    const id = this[which];
    if (id !== null) this.clearTimer(id);
    this[which] = null;
  }

  private stopTimers() {
    this.clear('timeout');
    this.clear('retryTimer');
    this.clear('deadline');
  }
}

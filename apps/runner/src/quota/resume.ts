import type { Cancel, Clock } from '../clock';
import { detectQuota, type QuotaReading } from '../collectors/tmux/classify';
import { errorMessage, type Logger } from '../log';

/** The runner waits this long past the reset before typing (spec 741 D4). */
export const RESUME_GRACE_MS = 60_000;
/** What is typed into the session. */
export const RESUME_TEXT = 'continue';

/** The pane a limit was seen on: how to read it, and how to type into it. */
export interface ResumeTarget {
  /** The pane's visible text; null when it cannot be read. */
  capture(): Promise<string | null>;
  /** Types `text` literally, then submits it. */
  type(text: string): Promise<void>;
}

interface Waiting {
  cancel: Cancel;
}

/**
 * Resumes sessions whose limit has reset (spec 741 D4).
 *
 * `observe` is fed each poll's reading of a pane, under a key for that pane.
 * The first reading with a reset time arms a timer for that time plus a
 * minute; the banner is then read again, and only if it is still there is
 * `continue` typed — once. A pane showing no banner forgets the key, so a
 * later banner is a new one. A reading with no reset time arms nothing.
 *
 * Nothing is kept across a restart: the next poll of a pane still showing its
 * banner arms it again.
 */
export class QuotaResumer {
  /** Keys with a timer running or already resumed, until the banner leaves. */
  private armed = new Map<string, Waiting | null>();

  constructor(
    private readonly clock: Clock,
    private readonly log: Logger,
  ) {}

  observe(
    key: string,
    quota: QuotaReading | null,
    target: ResumeTarget,
    onResumed: () => void,
  ): void {
    if (quota === null) {
      this.forget(key);
      return;
    }
    if (this.armed.has(key) || quota.resetsAt === null) return;
    const at = Date.parse(quota.resetsAt) + RESUME_GRACE_MS;
    const wait = Math.max(0, at - this.clock.now());
    const cancel = this.clock.setTimeout(
      () => void this.fire(key, target, onResumed),
      wait,
    );
    this.armed.set(key, { cancel });
  }

  /** Stops watching a pane, e.g. its session ended. */
  forget(key: string): void {
    this.armed.get(key)?.cancel();
    this.armed.delete(key);
  }

  private async fire(
    key: string,
    target: ResumeTarget,
    onResumed: () => void,
  ): Promise<void> {
    // Spent: whatever happens next, this banner is not tried again.
    this.armed.set(key, null);
    try {
      const text = await target.capture();
      // A person already acted, or the pane is gone: send nothing.
      if (text === null || detectQuota(text) === null) return;
      await target.type(RESUME_TEXT);
      onResumed();
    } catch (error) {
      // Not retried; the banner is still shown, so the Board still says the
      // session waits.
      this.log.warn('quota: could not resume a session', {
        key,
        error: errorMessage(error),
      });
    }
  }
}

import type { PaneDialog } from '@agentdock/shared/protocol';
import type { PaneReading } from './classify';

/** `watch.sh` reports IDLE after this many empty polls in a row. */
export const IDLE_POLLS = 3;

export type PaneChange =
  | { type: 'pane.prompt'; dialog: PaneDialog }
  | { type: 'pane.idle'; polls: number }
  | { type: 'pane.quota_hit' }
  | { type: 'pane.busy' };

type Reported = 'prompt' | 'idle' | 'quota' | 'busy' | null;

/**
 * `watch.sh`'s per-pane state machine (`idle_count`, `prompt_seen`), turned
 * into changes rather than alarms (spec 11 D2):
 * - a dialog is reported once per occurrence, on the poll it first appears;
 * - an empty prompt is reported on the third poll in a row;
 * - the quota banner is reported when it appears, and holds the pane at
 *   `quota` (no idle or busy) while it stays on screen;
 * - `esc to interrupt` is reported when the pane comes back from any other
 *   state, so a slot leaves `idle` / `prompt` / `quota`.
 */
export class PaneTracker {
  private idleCount = 0;
  private promptSeen = false;
  private quotaSeen = false;
  private reported: Reported = null;

  /** Feeds one poll's reading; returns the changes to emit, in order. */
  next(reading: PaneReading): PaneChange[] {
    const changes: PaneChange[] = [];
    if (reading.quota && !this.quotaSeen) {
      changes.push(this.report('quota', { type: 'pane.quota_hit' }));
    }
    this.quotaSeen = reading.quota;

    switch (reading.kind) {
      case 'dialog':
        if (!this.promptSeen) {
          changes.push(
            this.report('prompt', {
              type: 'pane.prompt',
              dialog: reading.dialog ?? 'other',
            }),
          );
        }
        this.promptSeen = true;
        this.idleCount = 0;
        break;
      case 'busy':
        this.idleCount = 0;
        this.promptSeen = false;
        if (!reading.quota && this.reported !== 'busy') {
          changes.push(this.report('busy', { type: 'pane.busy' }));
        }
        break;
      case 'quiet':
        this.promptSeen = false;
        this.idleCount += 1;
        if (this.idleCount === IDLE_POLLS && !reading.quota) {
          changes.push(
            this.report('idle', { type: 'pane.idle', polls: IDLE_POLLS }),
          );
        }
        break;
    }
    return changes;
  }

  private report(state: Reported, change: PaneChange): PaneChange {
    this.reported = state;
    return change;
  }
}

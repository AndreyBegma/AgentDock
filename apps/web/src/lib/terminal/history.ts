import { TERMINAL_HISTORY_LINES } from '@nautelle/shared/protocol';

/**
 * Inline scrollback of an attach (#522). tmux redraws the whole screen of an
 * attach, so the live xterm never fills its own scrollback; scrolling up asks
 * the runner for the pane's history instead, and it is shown in a read-only
 * view over the live one. Nothing here sends input to the PTY.
 */

/** Where the view is: the live terminal, waiting for history, or showing it. */
export type HistoryView = 'live' | 'loading' | 'shown';

/** How far a finger moves down on the live view before it asks for history. */
export const HISTORY_SWIPE_PX = 24;
/** A request that has no answer by then gives up and stays live. */
export const HISTORY_WAIT_MS = 10_000;

/**
 * The captured lines as one xterm write. tmux's `-e` emits a colour once,
 * where it changes, so lines carry on the colour of the line above: they are
 * joined as they are, and the attributes are reset only at the end.
 */
export const historyText = (lines: readonly string[]): string =>
  `${lines.join('\r\n')}\u001b[0m`;

/**
 * The history state of one attach. `scrolledUp` says when to send the one
 * `{ type: 'history' }` frame; chunks are collected until the `last` one and
 * then handed over as lines. A chunk that arrives while live (after a
 * timeout or a return to live) is dropped.
 */
export class HistoryController {
  private view: HistoryView = 'live';
  private lines: string[] = [];

  constructor(private readonly onView: (view: HistoryView) => void) {}

  get state(): HistoryView {
    return this.view;
  }

  /** The person scrolled up on the live view: true when a request should go out now. */
  scrolledUp(): boolean {
    if (this.view !== 'live') return false;
    this.lines = [];
    this.set('loading');
    return true;
  }

  /** One `history` frame; the lines once the last chunk is in, else null. */
  received(chunk: {
    lines: readonly string[];
    last: boolean;
  }): string[] | null {
    if (this.view !== 'loading') return null;
    this.lines.push(...chunk.lines);
    if (!chunk.last) return null;
    const lines = this.lines.slice(-TERMINAL_HISTORY_LINES);
    this.lines = [];
    if (lines.length === 0) {
      this.set('live');
      return null;
    }
    this.set('shown');
    return lines;
  }

  /** Back to the live view: the button, scrolling to the bottom, a timeout or a lost socket. */
  live(): void {
    this.lines = [];
    this.set('live');
  }

  private set(view: HistoryView): void {
    if (this.view === view) return;
    this.view = view;
    this.onView(view);
  }
}

/**
 * A vertical swipe, from `touchstart` to `touchend`: `swipe` answers `down`
 * (the finger pulled earlier output into view) or `up` once it has travelled
 * `HISTORY_SWIPE_PX`, and null before.
 */
export class Swipe {
  private from: number | null = null;

  start(y: number): void {
    this.from = y;
  }

  swipe(y: number): 'down' | 'up' | null {
    if (this.from === null) return null;
    const travel = y - this.from;
    if (travel >= HISTORY_SWIPE_PX) return 'down';
    if (travel <= -HISTORY_SWIPE_PX) return 'up';
    return null;
  }

  end(): void {
    this.from = null;
  }
}

/**
 * Lines one wheel event scrolls the history view: positive is down, towards
 * the live end. `deltaMode` 1 counts lines and 2 pages; 0 counts pixels.
 * Never 0 for a non-zero delta, so a small trackpad step still moves.
 */
export const wheelLines = (
  deltaY: number,
  deltaMode: number,
  cellPx: number,
  rows: number,
): number => {
  if (deltaY === 0) return 0;
  const lines =
    deltaMode === 1
      ? deltaY
      : deltaMode === 2
        ? deltaY * rows
        : deltaY / Math.max(1, cellPx);
  const whole = Math.trunc(lines);
  return whole === 0 ? Math.sign(deltaY) : whole;
};

/**
 * A finger dragging the history view, in whole lines: `lines` answers how
 * many lines to scroll since the last call — positive when the finger moved
 * down, which brings earlier output into view — and keeps the remainder.
 */
export class TouchScroll {
  private y: number | null = null;

  start(y: number): void {
    this.y = y;
  }

  lines(y: number, cellPx: number): number {
    if (this.y === null) return 0;
    const step = Math.max(1, cellPx);
    const whole = Math.trunc((y - this.y) / step);
    this.y += whole * step;
    return whole;
  }

  end(): void {
    this.y = null;
  }
}

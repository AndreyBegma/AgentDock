import type { PaneFrame } from '@agentdock/shared/protocol';

export interface PaneState {
  lines: string[];
  cursor: { x: number; y: number } | null;
  /** The session is gone; `lines` stay as the last frame (spec D7). */
  ended: boolean;
}

export const EMPTY_PANE: PaneState = { lines: [], cursor: null, ended: false };

/**
 * One frame onto the pane. `full` replaces everything (a late joiner makes
 * the relay send a fresh one to every viewer), `patch` replaces from `from`
 * to the end, `ended` keeps the lines. A big frame arrives as a `full` then
 * `patch`es: applying every frame in order yields the original.
 */
export function applyFrame(state: PaneState, frame: PaneFrame): PaneState {
  switch (frame.type) {
    case 'full':
      return { lines: frame.lines, cursor: frame.cursor, ended: false };
    case 'patch': {
      // A `from` past the end would leave a hole; append instead.
      const from = Math.min(frame.from, state.lines.length);
      return {
        ...state,
        lines: [...state.lines.slice(0, from), ...frame.lines],
        ended: false,
      };
    }
    case 'ended':
      return { ...state, ended: true };
  }
}

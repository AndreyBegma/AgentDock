import {
  type DesignTheme,
  type MockupMessage,
  type MockupPinMarker,
  mockupMessageSchema,
  VIEWER_MESSAGE_SOURCE,
  type ViewerMessage,
} from '@agentdock/shared';

/**
 * The viewer's side of the pin protocol (`@agentdock/shared` `pin.ts`). The
 * mockup has an opaque origin, so a message is trusted by the window it came
 * from, never by its origin: only the frame's own window counts, and only a
 * message that parses.
 */
export function readMockupMessage(
  event: Pick<MessageEvent, 'source' | 'data'>,
  frame: MessageEventSource | null,
): MockupMessage | null {
  if (frame === null || event.source !== frame) return null;
  const parsed = mockupMessageSchema.safeParse(event.data);
  return parsed.success ? parsed.data : null;
}

export const themeMessage = (theme: DesignTheme): ViewerMessage => ({
  source: VIEWER_MESSAGE_SOURCE,
  type: 'theme',
  theme,
});

export const pinModeMessage = (on: boolean): ViewerMessage => ({
  source: VIEWER_MESSAGE_SOURCE,
  type: 'pin-mode',
  on,
});

export const pinsMessage = (
  pins: MockupPinMarker[],
  scale?: number,
): ViewerMessage => ({
  source: VIEWER_MESSAGE_SOURCE,
  type: 'pins',
  pins,
  ...(scale === undefined ? {} : { scale }),
});

/**
 * Everything the frame needs after `ready` or a change: theme, pin mode and
 * markers, in that order. Sent whole each time — it is three small messages,
 * and a frame that reloaded has forgotten all of it.
 */
export const frameSync = (
  theme: DesignTheme,
  pinMode: boolean,
  pins: MockupPinMarker[],
  scale?: number,
): ViewerMessage[] => [
  themeMessage(theme),
  pinModeMessage(pinMode),
  pinsMessage(pins, scale),
];

/** Longest `selector` the viewer takes from a frame; the helper's own path is cut at `DESIGN_SELECTOR_MAX`. */
export const PIN_SELECTOR_MAX = 500;
/** What the helper's `cssPath` writes: ids, tags, `:nth-of-type(n)` and ` > `. */
const PIN_SELECTOR_CHARS = /^[\p{L}\p{N}_\-#.:()> \\[\]="'*+~,]+$/u;
/** How long after the pointer left the frame a `pin` still counts (a tap ends with `pointerleave`). */
export const PIN_POINTER_WINDOW_MS = 1000;

/**
 * Whether a `pin` from the frame is taken. A mockup's script can post
 * anything, so the viewer asks for more than a parsed message: pin mode must
 * be on, the pointer must be over the frame (or just have left it), and the
 * selector must look like the path the helper writes.
 */
export const acceptPin = (
  pin: { selector: string },
  state: { pinMode: boolean; pointer: PointerGate; now: number },
): boolean =>
  state.pinMode &&
  state.pointer.active(state.now) &&
  pin.selector.length <= PIN_SELECTOR_MAX &&
  PIN_SELECTOR_CHARS.test(pin.selector);

/** Tracks the pointer over the frame element: the only pointer signal a sandboxed frame cannot forge. */
export class PointerGate {
  private inside = false;
  private leftAt = Number.NEGATIVE_INFINITY;

  enter(): void {
    this.inside = true;
  }

  leave(now: number): void {
    this.inside = false;
    this.leftAt = now;
  }

  active(now: number): boolean {
    return this.inside || now - this.leftAt <= PIN_POINTER_WINDOW_MS;
  }
}

/** Per-frame load count: the first load is the mockup, a second one is the mockup navigating itself away. */
export interface FrameLoads {
  src: string;
  loads: number;
}

export const frameLoaded = (state: FrameLoads, src: string): FrameLoads =>
  state.src === src ? { src, loads: state.loads + 1 } : { src, loads: 1 };

export const frameEscaped = (state: FrameLoads, src: string): boolean =>
  state.src === src && state.loads > 1;

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

export const pinsMessage = (pins: MockupPinMarker[]): ViewerMessage => ({
  source: VIEWER_MESSAGE_SOURCE,
  type: 'pins',
  pins,
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
): ViewerMessage[] => [
  themeMessage(theme),
  pinModeMessage(pinMode),
  pinsMessage(pins),
];

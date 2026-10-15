import { describe, expect, test } from 'bun:test';
import { MOCKUP_MESSAGE_SOURCE, viewerMessageSchema } from '@agentdock/shared';
import { frameSync, readMockupMessage } from './frame-messages';

const frame = {} as MessageEventSource;
const other = {} as MessageEventSource;
const pin = {
  source: MOCKUP_MESSAGE_SOURCE,
  type: 'pin',
  x: 1,
  y: 2,
  clientX: 1,
  clientY: 2,
  selector: 'main',
};

describe('readMockupMessage', () => {
  test("accepts a parsed message from the frame's own window", () => {
    expect(readMockupMessage({ source: frame, data: pin }, frame)).toEqual(
      pin as never,
    );
  });

  test('ignores another window, a missing frame and a malformed message', () => {
    expect(readMockupMessage({ source: other, data: pin }, frame)).toBeNull();
    expect(readMockupMessage({ source: frame, data: pin }, null)).toBeNull();
    expect(
      readMockupMessage({ source: frame, data: { ...pin, x: -5 } }, frame),
    ).toBeNull();
    expect(
      readMockupMessage(
        { source: frame, data: { ...pin, source: 'agentdock-viewer' } },
        frame,
      ),
    ).toBeNull();
  });
});

describe('frameSync', () => {
  test('theme, pin mode and markers, each a valid viewer message', () => {
    const messages = frameSync('dark', true, [{ n: 1, x: 3, y: 4 }]);
    expect(messages.map((m) => m.type)).toEqual(['theme', 'pin-mode', 'pins']);
    for (const m of messages) {
      expect(viewerMessageSchema.safeParse(m).success).toBe(true);
    }
  });
});

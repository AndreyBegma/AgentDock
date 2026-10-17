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

  test('reads a Ctrl/⌘ + wheel forwarded by the helper', () => {
    const wheel = { source: MOCKUP_MESSAGE_SOURCE, type: 'wheel', deltaY: -80 };
    expect(readMockupMessage({ source: frame, data: wheel }, frame)).toEqual(
      wheel as never,
    );
    expect(readMockupMessage({ source: other, data: wheel }, frame)).toBeNull();
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

describe('frameSync on a touch screen', () => {
  test('the zoom travels with the markers so the helper can size them', () => {
    const pins = frameSync('dark', false, [{ n: 1, x: 3, y: 4 }], 0.5)[2];
    expect(viewerMessageSchema.safeParse(pins).success).toBe(true);
    expect(pins).toMatchObject({ type: 'pins', scale: 0.5 });
  });

  test('without it the message is as before', () => {
    expect(frameSync('dark', false, [])[2]).not.toHaveProperty('scale');
  });
});

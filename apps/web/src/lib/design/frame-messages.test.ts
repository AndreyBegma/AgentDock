import { describe, expect, test } from 'bun:test';
import { MOCKUP_MESSAGE_SOURCE, viewerMessageSchema } from '@nautelle/shared';
import {
  acceptPin,
  frameEscaped,
  frameLoaded,
  frameSync,
  PIN_SELECTOR_MAX,
  PointerGate,
  readMockupMessage,
} from './frame-messages';

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

describe('acceptPin (C-130)', () => {
  const over = () => {
    const gate = new PointerGate();
    gate.enter();
    return gate;
  };

  test('takes a pin in pin mode while the pointer is over the frame', () => {
    expect(acceptPin(pin, { pinMode: true, pointer: over(), now: 10 })).toBe(
      true,
    );
  });

  test('refuses a pin while pin mode is off', () => {
    expect(acceptPin(pin, { pinMode: false, pointer: over(), now: 10 })).toBe(
      false,
    );
  });

  test('refuses a pin when the pointer has not been near the frame', () => {
    expect(
      acceptPin(pin, { pinMode: true, pointer: new PointerGate(), now: 10 }),
    ).toBe(false);
    const gate = over();
    gate.leave(100);
    expect(acceptPin(pin, { pinMode: true, pointer: gate, now: 600 })).toBe(
      true,
    );
    expect(acceptPin(pin, { pinMode: true, pointer: gate, now: 5000 })).toBe(
      false,
    );
  });

  test('refuses an over-long selector or odd characters', () => {
    const state = { pinMode: true, pointer: over(), now: 10 };
    expect(
      acceptPin({ selector: 'a'.repeat(PIN_SELECTOR_MAX + 1) }, state),
    ).toBe(false);
    expect(acceptPin({ selector: '<img src=x onerror=1>' }, state)).toBe(false);
    expect(
      acceptPin(
        { selector: '#main > div:nth-of-type(2) > p:nth-of-type(1)' },
        state,
      ),
    ).toBe(true);
  });
});

describe('frame loads (C-130)', () => {
  test('a second load of the same src is the mockup leaving', () => {
    let state = frameLoaded({ src: 'a.html', loads: 0 }, 'a.html');
    expect(frameEscaped(state, 'a.html')).toBe(false);
    state = frameLoaded(state, 'a.html');
    expect(frameEscaped(state, 'a.html')).toBe(true);
  });

  test('another src starts over, so it is per frame', () => {
    const state = frameLoaded(
      frameLoaded({ src: 'a.html', loads: 0 }, 'a.html'),
      'a.html',
    );
    expect(frameEscaped(state, 'b.html')).toBe(false);
    expect(frameEscaped(frameLoaded(state, 'b.html'), 'b.html')).toBe(false);
  });
});

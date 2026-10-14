import { describe, expect, it } from 'bun:test';
import {
  MOCKUP_MESSAGE_SOURCE,
  MOCKUP_PIN_HELPER_SCRIPT,
  type MockupMessage,
  mockupMessageSchema,
  VIEWER_MESSAGE_SOURCE,
} from './pin';

type Listener = (event: Record<string, unknown>) => void;

/**
 * Runs the helper against the smallest window it touches: one capturing
 * click listener on the document, one message listener on the window, and a
 * parent that records what it is sent.
 */
const runHelper = () => {
  const sent: unknown[] = [];
  const parent = { postMessage: (msg: unknown) => sent.push(msg) };
  const listeners: { click?: Listener; message?: Listener } = {};
  const root = { style: { cursor: '' }, setAttribute: () => {} };
  const body = { nodeType: 1, tagName: 'BODY', parentElement: root };
  const document = {
    documentElement: root,
    body,
    addEventListener: (type: 'click', fn: Listener) => {
      listeners[type] = fn;
    },
  };
  const window = {
    parent,
    addEventListener: (type: 'message', fn: Listener) => {
      listeners[type] = fn;
    },
  };
  new Function('window', 'document', 'CSS', MOCKUP_PIN_HELPER_SCRIPT)(
    window,
    document,
    { escape: (s: string) => s },
  );
  const viewer = (data: Record<string, unknown>) =>
    listeners.message?.({
      source: parent,
      data: { source: VIEWER_MESSAGE_SOURCE, ...data },
    });
  const click = (at: Record<string, number>) =>
    listeners.click?.({
      ...at,
      target: body,
      preventDefault: () => {},
      stopPropagation: () => {},
    });
  return { sent, viewer, click };
};

describe('the pin message', () => {
  const pin = {
    source: MOCKUP_MESSAGE_SOURCE,
    type: 'pin',
    x: 120,
    y: 2400,
    selector: 'main:nth-of-type(1)',
  };

  it('carries the click in the frame viewport beside its page position', () => {
    const parsed = mockupMessageSchema.safeParse({
      ...pin,
      clientX: 120,
      clientY: 300,
    });
    expect(parsed.success).toBe(true);
  });

  it('still parses without the viewport position (a helper served before it)', () => {
    expect(mockupMessageSchema.safeParse(pin).success).toBe(true);
  });

  it('refuses a negative or non-finite viewport position', () => {
    for (const clientY of [-1, Number.POSITIVE_INFINITY]) {
      expect(
        mockupMessageSchema.safeParse({ ...pin, clientX: 1, clientY }).success,
      ).toBe(false);
    }
  });
});

describe('the pin helper', () => {
  it('says ready, and sends nothing on a click outside pin mode', () => {
    const { sent, click } = runHelper();
    click({ pageX: 10, pageY: 900, clientX: 10, clientY: 100 });
    expect(sent).toEqual([{ type: 'ready', source: MOCKUP_MESSAGE_SOURCE }]);
  });

  it('sends page and viewport positions of a click in pin mode', () => {
    const { sent, viewer, click } = runHelper();
    viewer({ type: 'pin-mode', on: true });
    click({ pageX: 40, pageY: 1240, clientX: 40, clientY: 240 });
    const message = mockupMessageSchema.parse(sent.at(-1)) as MockupMessage;
    expect(message).toEqual({
      source: MOCKUP_MESSAGE_SOURCE,
      type: 'pin',
      x: 40,
      y: 1240,
      clientX: 40,
      clientY: 240,
      selector: 'body:nth-of-type(1)',
    });
  });
});

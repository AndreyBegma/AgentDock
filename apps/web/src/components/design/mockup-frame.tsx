'use client';

import type {
  DesignTheme,
  MockupMessage,
  MockupPinMarker,
} from '@agentdock/shared';
import { useEffect, useRef, useState } from 'react';
import {
  acceptPin,
  type FrameLoads,
  frameEscaped,
  frameLoaded,
  frameSync,
  PointerGate,
  readMockupMessage,
} from '../../lib/design/frame-messages';

/** A click in pin mode, with the frame's box to anchor a comment to. */
export type FramePin = Extract<MockupMessage, { type: 'pin' }> & {
  frame: DOMRect;
};

export const MOCKUP_ESCAPED_NOTICE = 'The mockup tried to leave this page';

/**
 * The mockup (spec 223 D6, D9, D11): an `iframe sandbox="allow-scripts"` on
 * the mockup endpoint — no `allow-same-origin`, so the document has an
 * opaque origin, no cookies and no storage of Nautelle. The viewer talks to
 * the pin helper inside it by `postMessage` only: theme, pin mode and the
 * markers go in once the helper says `ready` and again on every change, so
 * flipping the theme never reloads the frame.
 */
export function MockupFrame({
  src,
  title,
  theme,
  pinMode,
  pins,
  onPin,
  onPinOpen,
  onWheel,
  touchScale,
}: {
  src: string;
  title: string;
  theme: DesignTheme;
  pinMode: boolean;
  pins: MockupPinMarker[];
  onPin: (pin: FramePin) => void;
  /** A tap on a saved marker (touch screens only, see `touchScale`). */
  onPinOpen?: (n: number) => void;
  /**
   * On a touch screen, the zoom: the helper then draws markers at a 44px tap
   * size however far the mockup is scaled, and reports a tap on one.
   */
  touchScale?: number;
  /** Ctrl/⌘ + wheel over the mockup, forwarded by the helper (it cannot bubble out). */
  onWheel: (deltaY: number) => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const pointer = useRef(new PointerGate());
  // Every `MockupFrame` is one frame of one document: a second `load` of the
  // same `src` is the mockup navigating itself somewhere else (C-130).
  const [loads, setLoads] = useState<FrameLoads>({ src, loads: 0 });
  const escaped = frameEscaped(loads, src);
  // Which document said `ready`: a new `src` loads a new one.
  const [readySrc, setReadySrc] = useState<string | null>(null);
  const ready = readySrc === src;

  const latest = useRef({
    theme,
    pinMode,
    pins,
    onPin,
    onPinOpen,
    onWheel,
    touchScale,
  });
  useEffect(() => {
    latest.current = {
      theme,
      pinMode,
      pins,
      onPin,
      onPinOpen,
      onWheel,
      touchScale,
    };
  });

  const wheelDelta = useRef(0);
  const wheelFrame = useRef<number | null>(null);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const element = frame.current;
      const message = readMockupMessage(event, element?.contentWindow ?? null);
      if (!message || !element) return;
      if (message.type === 'ready') {
        setReadySrc(src);
        // A reload of the same `src` says `ready` again: sync it now.
        const { theme: t, pinMode: p, pins: m, touchScale: z } = latest.current;
        for (const out of frameSync(t, p, m, z)) {
          element.contentWindow?.postMessage(out, '*');
        }
        return;
      }
      if (message.type === 'wheel') {
        // A wheel needs a hand on the frame, and arrives once per frame.
        if (!pointer.current.active(performance.now())) return;
        wheelDelta.current += message.deltaY;
        if (wheelFrame.current === null) {
          wheelFrame.current = requestAnimationFrame(() => {
            wheelFrame.current = null;
            const delta = wheelDelta.current;
            wheelDelta.current = 0;
            if (delta !== 0) latest.current.onWheel(delta);
          });
        }
        return;
      }
      if (message.type === 'pin-open') {
        latest.current.onPinOpen?.(message.n);
        return;
      }
      const { pinMode: on } = latest.current;
      if (
        !acceptPin(message, {
          pinMode: on,
          pointer: pointer.current,
          now: performance.now(),
        })
      ) {
        return;
      }
      latest.current.onPin({
        ...message,
        frame: element.getBoundingClientRect(),
      });
    };
    window.addEventListener('message', onMessage);
    return () => {
      window.removeEventListener('message', onMessage);
      if (wheelFrame.current !== null) cancelAnimationFrame(wheelFrame.current);
      wheelFrame.current = null;
      wheelDelta.current = 0;
    };
  }, [src]);

  useEffect(() => {
    if (!ready) return;
    const target = frame.current?.contentWindow;
    // Opaque origin: there is no origin to name, and the messages hold no secret.
    for (const out of frameSync(theme, pinMode, pins, touchScale)) {
      target?.postMessage(out, '*');
    }
  }, [ready, theme, pinMode, pins, touchScale]);

  return (
    <MockupFrameShell
      escaped={escaped}
      src={src}
      title={title}
      frameRef={frame}
      onLoad={() => setLoads((state) => frameLoaded(state, src))}
      onPointerEnter={() => pointer.current.enter()}
      onPointerLeave={() => pointer.current.leave(performance.now())}
    />
  );
}

/** The iframe, or — once the mockup has navigated it away — a notice in its place. */
export function MockupFrameShell({
  escaped,
  src,
  title,
  frameRef,
  onLoad,
  onPointerEnter,
  onPointerLeave,
}: {
  escaped: boolean;
  src: string;
  title: string;
  frameRef?: React.Ref<HTMLIFrameElement>;
  onLoad?: () => void;
  onPointerEnter?: () => void;
  onPointerLeave?: () => void;
}) {
  if (escaped) {
    return (
      <div
        role="alert"
        className="flex size-full items-center justify-center bg-white p-6 text-center text-neutral-900"
      >
        {MOCKUP_ESCAPED_NOTICE}
      </div>
    );
  }
  return (
    <iframe
      ref={frameRef}
      onLoad={onLoad}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      key={src}
      src={src}
      title={title}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      className="block size-full border-0 bg-white"
    />
  );
}

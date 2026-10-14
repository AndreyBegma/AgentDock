'use client';

import type {
  DesignTheme,
  MockupMessage,
  MockupPinMarker,
} from '@agentdock/shared';
import { useEffect, useRef, useState } from 'react';
import { frameSync, readMockupMessage } from '../../lib/design/frame-messages';

/** A click in pin mode, with the frame's box to anchor a comment to. */
export type FramePin = Extract<MockupMessage, { type: 'pin' }> & {
  frame: DOMRect;
};

/**
 * The mockup (spec 223 D6, D9, D11): an `iframe sandbox="allow-scripts"` on
 * the mockup endpoint — no `allow-same-origin`, so the document has an
 * opaque origin, no cookies and no storage of AgentDock. The viewer talks to
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
}: {
  src: string;
  title: string;
  theme: DesignTheme;
  pinMode: boolean;
  pins: MockupPinMarker[];
  onPin: (pin: FramePin) => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  // Which document said `ready`: a new `src` loads a new one.
  const [readySrc, setReadySrc] = useState<string | null>(null);
  const ready = readySrc === src;

  const latest = useRef({ theme, pinMode, pins, onPin });
  useEffect(() => {
    latest.current = { theme, pinMode, pins, onPin };
  });

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const element = frame.current;
      const message = readMockupMessage(event, element?.contentWindow ?? null);
      if (!message || !element) return;
      if (message.type === 'ready') {
        setReadySrc(src);
        // A reload of the same `src` says `ready` again: sync it now.
        const { theme: t, pinMode: p, pins: m } = latest.current;
        for (const out of frameSync(t, p, m)) {
          element.contentWindow?.postMessage(out, '*');
        }
        return;
      }
      latest.current.onPin({
        ...message,
        frame: element.getBoundingClientRect(),
      });
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [src]);

  useEffect(() => {
    if (!ready) return;
    const target = frame.current?.contentWindow;
    // Opaque origin: there is no origin to name, and the messages hold no secret.
    for (const out of frameSync(theme, pinMode, pins)) {
      target?.postMessage(out, '*');
    }
  }, [ready, theme, pinMode, pins]);

  return (
    <iframe
      ref={frame}
      key={src}
      src={src}
      title={title}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      className="block size-full border-0 bg-white"
    />
  );
}

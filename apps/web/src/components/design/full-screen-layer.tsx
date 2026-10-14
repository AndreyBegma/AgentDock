'use client';

import { type ReactNode, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * A full-screen layer over the shell. glass-ui's depth effect pushes
 * `#main-content` back when a sheet or dialog opens, and a transformed
 * ancestor turns `position: fixed` into "fixed to that ancestor" — so a
 * full-screen page must live outside it (glass-ui `base.css`'s contract).
 * It mounts in `document.body` after hydration; the server renders nothing.
 */
export function FullScreenLayer({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  const [host, setHost] = useState<HTMLElement | null>(null);
  useEffect(() => setHost(document.body), []);
  if (!host) return null;
  return createPortal(
    <section
      aria-label={label}
      className="fixed inset-0 z-[calc(var(--z-index-chrome)+1)] flex flex-col bg-ground text-ink"
    >
      {children}
    </section>,
    host,
  );
}

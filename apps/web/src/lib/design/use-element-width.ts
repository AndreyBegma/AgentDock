'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * The content width of an element, kept current by a `ResizeObserver` (spec
 * 335 D2: Fit is recomputed on stage resize). Returns a callback ref — the
 * element mounts and unmounts with the revision in view — and the width, 0
 * until it is measured.
 */
export function useElementWidth(): [(el: HTMLElement | null) => void, number] {
  const [element, setElement] = useState<HTMLElement | null>(null);
  const [width, setWidth] = useState(0);
  const ref = useCallback((el: HTMLElement | null) => setElement(el), []);

  useEffect(() => {
    if (!element) return;
    setWidth(element.clientWidth);
    const observer = new ResizeObserver(() => setWidth(element.clientWidth));
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);

  return [ref, width];
}

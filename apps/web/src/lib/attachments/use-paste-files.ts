'use client';

import { useEffect, useRef } from 'react';

/**
 * Files pasted anywhere on the page while `enabled` (the open card sheet,
 * spec "UI"). A paste a dropzone already took is `defaultPrevented` and
 * skipped, so one screenshot is never attached twice.
 */
export function usePasteFiles(
  enabled: boolean,
  onFiles: (files: File[]) => void,
): void {
  const handler = useRef(onFiles);
  handler.current = onFiles;
  useEffect(() => {
    if (!enabled) return;
    const paste = (e: ClipboardEvent) => {
      if (e.defaultPrevented) return;
      const files = Array.from(e.clipboardData?.files ?? []);
      if (files.length === 0) return;
      e.preventDefault();
      handler.current(files);
    };
    document.addEventListener('paste', paste);
    return () => document.removeEventListener('paste', paste);
  }, [enabled]);
}

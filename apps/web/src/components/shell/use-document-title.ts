'use client';

import { useEffect, useRef } from 'react';
import { APP_NAME } from './crumbs';

/** The root layout's `title.default`: what a page without metadata gets. */
const DEFAULT_TITLE = APP_NAME;

/**
 * Client pages have no metadata of their own, so the trail names the tab.
 * Next writes the metadata title after this effect (it streams), so the
 * default is replaced whenever it appears, and so is the title this hook set
 * for the previous page; a page that set its own `metadata.title` keeps it.
 */
export function useDocumentTitle(title: string) {
  const ours = useRef<string | null>(null);
  useEffect(() => {
    const apply = () => {
      const current = document.title;
      if (current === title) return;
      if (current !== DEFAULT_TITLE && current !== ours.current) return;
      document.title = title;
      ours.current = title;
    };
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(document.head, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    return () => observer.disconnect();
  }, [title]);
}

'use client';

import { useCallback, useEffect, useState } from 'react';

const COLLAPSED_KEY = 'agentdock.nav.collapsed';

/** The toggle's name, which is also its tooltip: what pressing it does. */
export function railToggleLabel(collapsed: boolean): string {
  return collapsed ? 'Expand sidebar' : 'Collapse sidebar';
}

/** ⌘\ on a Mac, Ctrl+\ elsewhere — the editors' "toggle sidebar" chord. */
export function isRailToggleShortcut(event: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}): boolean {
  return (
    event.key === '\\' &&
    (event.metaKey || event.ctrlKey) &&
    !event.altKey &&
    !event.shiftKey
  );
}

/**
 * Whether the rail is narrowed to icons (C-14), remembered per browser like
 * the Admin group's fold. Starts expanded until storage is read, and when it
 * is blocked.
 */
export function useRailCollapsed(): [boolean, (collapsed: boolean) => void] {
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    try {
      setCollapsed(window.localStorage.getItem(COLLAPSED_KEY) === '1');
    } catch {
      // Storage blocked: the rail starts expanded.
    }
  }, []);
  const change = useCallback((next: boolean) => {
    setCollapsed(next);
    try {
      window.localStorage.setItem(COLLAPSED_KEY, next ? '1' : '0');
    } catch {
      // Not remembered; the toggle still works for this page.
    }
  }, []);
  return [collapsed, change];
}

/** Toggles the rail on ⌘\ / Ctrl+\ while `enabled` (the rail is on screen). */
export function useRailToggleShortcut(enabled: boolean, toggle: () => void) {
  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isRailToggleShortcut(event)) return;
      event.preventDefault();
      toggle();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [enabled, toggle]);
}

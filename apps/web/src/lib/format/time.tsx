'use client';

import { useSyncExternalStore } from 'react';
import {
  type DateInput,
  type DateStyle,
  formatAbsolute,
  formatDate,
  formatRelative,
} from './index';

/**
 * One interval for every `<Time>` on the page: relative times move on the
 * minute without each instance owning a timer.
 */
const TICK_MS = 60_000;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let now = Date.now();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (timer === null) {
    now = Date.now();
    timer = setInterval(() => {
      now = Date.now();
      for (const notify of listeners) notify();
    }, TICK_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
}

const getNow = () => now;

export function useNow(): number {
  return useSyncExternalStore(subscribe, getNow, getNow);
}

type TimeProps = {
  value: DateInput;
  /** `relative` (default): "5 min ago". A `DateStyle` prints the date itself. */
  format?: 'relative' | DateStyle;
  /** Shown when there is no value. */
  fallback?: string;
  className?: string;
};

/**
 * A point in time: readable text, the exact instant in the tooltip and in
 * `dateTime`. Server and browser disagree on "now" and on the timezone, so the
 * text is allowed to differ at hydration.
 */
export function Time({
  value,
  format = 'relative',
  fallback = '—',
  className,
}: TimeProps) {
  const current = useNow();
  const absolute = formatAbsolute(value);
  if (!absolute) return <span className={className}>{fallback}</span>;
  const text =
    format === 'relative'
      ? formatRelative(value, current)
      : formatDate(value, format);
  const iso = new Date(value as string | number | Date).toISOString();
  return (
    <time
      dateTime={iso}
      title={absolute}
      className={className}
      suppressHydrationWarning
    >
      {text}
    </time>
  );
}

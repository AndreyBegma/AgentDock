'use client';

import { useEffect, useState } from 'react';

/**
 * The "On this page" index beside a settings section (#704, desktop only):
 * one in-page link per block, the block in view marked current.
 */
export function SettingsIndex({
  items,
}: {
  items: readonly { id: string; label: string }[];
}) {
  const [current, setCurrent] = useState(items[0]?.id);

  useEffect(() => {
    // The current block is the last one whose top has passed the upper third
    // of the window; once a scrolled page reaches its end, the last block.
    let frame = 0;
    const update = () => {
      frame = 0;
      const line = window.innerHeight / 3;
      const atEnd =
        window.scrollY > 0 &&
        window.innerHeight + window.scrollY >=
          document.documentElement.scrollHeight - 2;
      let next = items[0]?.id;
      for (const { id } of items) {
        const top = document.getElementById(id)?.getBoundingClientRect().top;
        if (top !== undefined && (top <= line || atEnd)) next = id;
      }
      setCurrent(next);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      cancelAnimationFrame(frame);
    };
  }, [items]);

  return (
    <nav
      aria-label="On this page"
      className="sticky top-4 hidden flex-col gap-0.5 self-start text-sm desktop:flex"
    >
      <div className="px-2.5 pb-1 text-xs font-medium text-ink-3">
        On this page
      </div>
      {items.map(({ id, label }) => (
        <a
          key={id}
          href={`#${id}`}
          aria-current={id === current ? 'true' : undefined}
          className="rounded-md px-2.5 py-1 text-ink-2 hover:bg-hover hover:text-ink aria-[current]:bg-hover aria-[current]:text-ink"
        >
          {label}
        </a>
      ))}
    </nav>
  );
}

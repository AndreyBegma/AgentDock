'use client';

import type { DesignFrameView } from '@agentdock/shared';
import { Badge } from '@andrewbehma/glass-ui/badge';
import { Button } from '@andrewbehma/glass-ui/button';
import { Tab, TabList } from '@andrewbehma/glass-ui/tabs';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { framePath } from '../../lib/design/frames';

/** The keys the strip turns into a frame: the tablist's own, which only move focus. */
const STEP: Record<string, (at: number, last: number) => number> = {
  ArrowLeft: (at, last) => (at === 0 ? last : at - 1),
  ArrowRight: (at, last) => (at === last ? 0 : at + 1),
  Home: () => 0,
  End: (_, last) => last,
};

/**
 * #441: the frames of the revision in view, between the toolbar and the
 * mockup — a glass-ui `TabList` inside the viewer's `TabGroup`. Each tab
 * shows its position, the frame's name, its open comments and a dot when it
 * holds an open pin. The arrows, Home and End switch frames as they move
 * focus; `[` and `]` do it from anywhere on the stage. A revision stored
 * before frames shows its one frame, "Mockup".
 */
export function FrameStrip({
  frames,
  frame,
  variant,
  comments,
  pinned,
  onFrame,
}: {
  frames: readonly DesignFrameView[];
  /** The position of the frame in view. */
  frame: number;
  variant: number;
  /** Open comments per frame, by position. */
  comments: ReadonlyMap<number, number>;
  /** Frames with an open pin, by position. */
  pinned: ReadonlySet<number>;
  onFrame: (frame: number) => void;
}) {
  const last = frames.length - 1;
  const current = frames[frame];
  return (
    <div className="flex shrink-0 flex-col gap-1">
      <div className="flex min-w-0 items-center gap-2">
        <span id="design-frames-label" className="shrink-0 text-xs text-ink-3">
          Frames · {frames.length}
        </span>
        {/* biome-ignore lint/a11y/noStaticElementInteractions: the tabs inside take the keys; this turns their focus moves into a frame change */}
        <div
          className="min-w-0 flex-1 overflow-x-auto"
          onKeyDown={(event) => {
            const step = STEP[event.key];
            if (step) onFrame(step(frame, last));
          }}
        >
          <TabList aria-labelledby="design-frames-label" className="w-max">
            {frames.map((f) => {
              const open = comments.get(f.position) ?? 0;
              return (
                <Tab
                  key={f.position}
                  value={String(f.position)}
                  className="flex-none"
                >
                  <span className="inline-flex items-center gap-2">
                    <span className="text-ink-3 tabular-nums">
                      {f.position + 1}
                    </span>
                    <span className="max-w-48 truncate">{f.name}</span>
                    {open > 0 ? (
                      <Badge
                        count={open}
                        aria-label={`${open} open comment${open === 1 ? '' : 's'}`}
                      />
                    ) : null}
                    {pinned.has(f.position) ? (
                      <Badge tone="warn" dot aria-label="Open pins" />
                    ) : null}
                  </span>
                </Tab>
              );
            })}
          </TabList>
        </div>
        <Button
          size="sm"
          icon
          variant="ghost"
          aria-label="Previous frame"
          title="Previous frame ( [ )"
          disabled={frames.length < 2}
          onClick={() => onFrame(STEP.ArrowLeft(frame, last))}
        >
          <ChevronLeft aria-hidden="true" className="size-4" />
        </Button>
        <Button
          size="sm"
          icon
          variant="ghost"
          aria-label="Next frame"
          title="Next frame ( ] )"
          disabled={frames.length < 2}
          onClick={() => onFrame(STEP.ArrowRight(frame, last))}
        >
          <ChevronRight aria-hidden="true" className="size-4" />
        </Button>
      </div>
      {current ? (
        <p className="flex flex-wrap items-baseline gap-x-2 text-xs text-ink-3">
          <span className="font-semibold text-ink">{current.name}</span>
          <span aria-hidden="true">·</span>
          <span className="font-mono">{framePath(variant, current)}</span>
          <span aria-hidden="true">·</span>
          <span className="tabular-nums">
            Frame {frame + 1} of {frames.length}
          </span>
        </p>
      ) : null}
    </div>
  );
}

/** `[` and `]` on the stage: the previous and the next frame, wrapping. */
export function frameKey(
  event: { key: string },
  frame: number,
  count: number,
): number | null {
  if (count < 2) return null;
  if (event.key === '[') return frame === 0 ? count - 1 : frame - 1;
  if (event.key === ']') return frame === count - 1 ? 0 : frame + 1;
  return null;
}

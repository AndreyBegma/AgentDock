'use client';

import { Badge } from '@andrewbehma/glass-ui/badge';
import { Button } from '@andrewbehma/glass-ui/button';
import { Tab, TabList } from '@andrewbehma/glass-ui/tabs';
import type { DesignFrameView } from '@nautelle/shared';
import { Columns2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { framePath } from '../../lib/design/frames';
import { frameKindLabel } from '../../lib/design/templates';

/** The keys the tabs turn into a frame: the tablist's own, which only move focus. */
const STEP: Record<string, (at: number, last: number) => number> = {
  ArrowLeft: (at, last) => (at === 0 ? last : at - 1),
  ArrowRight: (at, last) => (at === last ? 0 : at + 1),
  Home: () => 0,
  End: (_, last) => last,
};

/**
 * #886: the frames of the revision in view as tabs above the device canvas —
 * a glass-ui `TabList` inside the viewer's `TabGroup`. A tab is named by its
 * frame (Screen, Breakdown, States…), with the kind beside it when the name
 * does not already say it, its open comments and a dot when it holds an open
 * pin. The arrows, Home and End switch tabs as they move focus; `[` and `]` do
 * it from the canvas. A revision stored before frames shows its one frame,
 * "Mockup", and a legacy `mobile` frame is one more tab.
 *
 * `tools` sit at the end of the row (theme, variant, revision); Compare comes
 * after them while there is more than one variant to see.
 */
export function FrameTabs({
  frames,
  frame,
  variant,
  comments,
  pinned,
  onFrame,
  templateName = null,
  compare,
  tools,
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
  /** #833 D11: the template the revision was drawn by; null for a legacy one. */
  templateName?: string | null;
  /** #833 D11: the Compare toggle; left out while there is one variant to see. */
  compare?: { on: boolean; onToggle: () => void };
  tools?: ReactNode;
}) {
  const last = frames.length - 1;
  const current = frames[frame];
  return (
    <div className="flex shrink-0 flex-col gap-1">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
        {/* biome-ignore lint/a11y/noStaticElementInteractions: the tabs inside take the keys; this turns their focus moves into a frame change */}
        <div
          className="min-w-0 flex-1 overflow-x-auto"
          onKeyDown={(event) => {
            const step = STEP[event.key];
            if (step && last > 0) onFrame(step(frame, last));
          }}
        >
          <TabList aria-label="Frames" className="w-max">
            {frames.map((f) => {
              const open = comments.get(f.position) ?? 0;
              const kind = frameKindLabel(f);
              return (
                <Tab
                  key={f.position}
                  value={String(f.position)}
                  className="flex-none"
                >
                  <span className="inline-flex items-center gap-2">
                    <span className="max-w-48 truncate">{f.name}</span>
                    {kind && !f.name.startsWith(kind) ? (
                      <span className="text-xs text-ink-3">{kind}</span>
                    ) : null}
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
        {tools}
        {compare ? (
          <Button
            size="sm"
            variant="glass"
            aria-pressed={compare.on}
            title="Show the same frame of every variant side by side"
            onClick={compare.onToggle}
          >
            <Columns2 aria-hidden="true" className="size-4" />
            Compare
          </Button>
        ) : null}
      </div>
      {current ? (
        <p className="flex flex-wrap items-baseline gap-x-2 text-xs text-ink-3">
          {templateName ? (
            <>
              <span>
                Template ·{' '}
                <span className="font-semibold text-ink">{templateName}</span>
              </span>
              <span aria-hidden="true">·</span>
            </>
          ) : null}
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

/** `[` and `]` on the canvas: the previous and the next tab, wrapping. */
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

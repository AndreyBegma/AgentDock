'use client';

import type { ViewportPreset } from '@nautelle/shared';
import { Maximize2 } from 'lucide-react';
import Link from 'next/link';
import { previewBox } from '../../lib/design/mobile-preview';
import { useElementWidth } from '../../lib/design/use-element-width';
import { MockupFrame } from './mockup-frame';

/**
 * #526: the mockup on a phone. It is laid out at the preset's width, as in a
 * real viewport, and drawn scaled to the container's (the viewer's Fit). The
 * box is cropped with a fade, and the link over it — the iframe takes touches
 * otherwise — opens the viewer.
 */
export function ScaledPreview({
  src,
  title,
  preset,
  href,
}: {
  src: string;
  title: string;
  preset: Pick<ViewportPreset, 'width' | 'height'>;
  href: string;
}) {
  const [measure, width] = useElementWidth();
  const { scale, height } = previewBox(preset, width);
  return (
    <div
      ref={measure}
      className="relative w-full overflow-hidden rounded-control border border-line-strong bg-surface"
      style={{ height }}
    >
      {width > 0 ? (
        <div
          className="origin-top-left"
          style={{
            width: preset.width,
            height: preset.height,
            transform: `scale(${scale})`,
          }}
        >
          <MockupFrame
            src={src}
            title={title}
            theme="light"
            pinMode={false}
            pins={[]}
            onPin={() => {}}
            onWheel={() => {}}
          />
        </div>
      ) : null}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 bottom-0 h-20 bg-gradient-to-t from-ground to-transparent"
      />
      <Link
        href={href}
        aria-label="Open the design in the viewer"
        className="absolute inset-0 flex items-end justify-center pb-3"
      >
        <span className="glass-strong inline-flex h-9 items-center gap-1.5 rounded-full px-3.5 text-xs font-semibold text-ink">
          <Maximize2 aria-hidden="true" className="size-3.5" />
          Open in viewer
        </span>
      </Link>
    </div>
  );
}

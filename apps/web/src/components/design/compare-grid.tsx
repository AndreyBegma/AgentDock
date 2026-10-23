'use client';

import type { DesignTheme, ViewportPreset } from '@nautelle/shared';
import type { CompareColumn } from '../../lib/design/templates';
import { useElementWidth } from '../../lib/design/use-element-width';
import { MockupFrame } from './mockup-frame';

/**
 * #833 D11: Compare — the frame at one position of every variant, side by
 * side, each laid out at the preset's width and scaled to its column. Pins
 * and comments stay on the single-variant view.
 */
export function CompareGrid({
  columns,
  preset,
  theme,
  position,
  variantInView,
  onPick,
}: {
  columns: readonly CompareColumn[];
  preset: Pick<ViewportPreset, 'width' | 'height'>;
  theme: DesignTheme;
  position: number;
  variantInView: number;
  /** Leaves Compare for the variant's own view. */
  onPick: (variant: number) => void;
}) {
  return (
    <section
      aria-label="Compare variants"
      className="grid min-w-0 gap-3"
      style={{
        gridTemplateColumns: `repeat(${columns.length}, minmax(0, 1fr))`,
      }}
    >
      {columns.map((column) => (
        <CompareCell
          key={column.variant}
          column={column}
          preset={preset}
          theme={theme}
          position={position}
          inView={column.variant === variantInView}
          onPick={onPick}
        />
      ))}
    </section>
  );
}

function CompareCell({
  column,
  preset,
  theme,
  position,
  inView,
  onPick,
}: {
  column: CompareColumn;
  preset: Pick<ViewportPreset, 'width' | 'height'>;
  theme: DesignTheme;
  position: number;
  inView: boolean;
  onPick: (variant: number) => void;
}) {
  const [measure, width] = useElementWidth();
  const scale = width > 0 ? width / preset.width : 0;
  const { frame, revision, variant } = column;
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex min-w-0 items-baseline justify-between gap-2 text-xs">
        <span className="font-semibold">Variant {variant}</span>
        <span className="truncate text-ink-3">
          {frame ? frame.name : `no frame ${position + 1}`}
        </span>
      </div>
      <div
        ref={measure}
        className={`relative w-full overflow-hidden rounded-control border bg-surface ${
          inView ? 'border-accent' : 'border-line-strong'
        }`}
        style={{ height: Math.round(preset.height * scale) || undefined }}
      >
        {frame && width > 0 ? (
          <div
            className="origin-top-left"
            style={{
              width: preset.width,
              height: preset.height,
              transform: `scale(${scale})`,
            }}
          >
            <MockupFrame
              src={frame.htmlUrl}
              title={`Mockup: ${revision.title} · ${frame.name}`}
              theme={theme}
              pinMode={false}
              pins={[]}
              onPin={() => {}}
              onWheel={() => {}}
            />
          </div>
        ) : null}
      </div>
      <button
        type="button"
        className="self-start text-xs text-accent underline-offset-2 hover:underline"
        onClick={() => onPick(variant)}
      >
        Open variant {variant}
      </button>
    </div>
  );
}

'use client';

import {
  DESIGN_THEMES,
  DESIGN_VIEWPORT_MAX_PX,
  DESIGN_VIEWPORT_MIN_PX,
  type DesignRevisionView,
  type DesignTheme,
  type ViewportPreset,
} from '@agentdock/shared';
import { Button } from '@andrewbehma/glass-ui/button';
import { Select } from '@andrewbehma/glass-ui/field';
import { NumberInput } from '@andrewbehma/glass-ui/number-input';
import {
  SegmentedControl,
  SegmentedControlItem,
} from '@andrewbehma/glass-ui/segmented-control';
import { Crosshair, Minus, Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { revisionLabel } from '../../lib/design/format';
import type { ViewerChange, ViewerState } from '../../lib/design/viewer-state';
import {
  stepZoom,
  ZOOM_MAX,
  ZOOM_MIN,
  ZOOM_PRESETS,
  zoomPercent,
} from '../../lib/design/zoom';

const THEME_LABEL: Record<DesignTheme, string> = {
  light: 'Light',
  dark: 'Dark',
};

/**
 * The viewer's toolbar (spec 223 D11): viewport presets, a typed width,
 * light/dark, the zoom (spec 335), the variant and the revision, and pin
 * mode. Every choice is a `ViewerChange`; the page keeps them in the URL.
 */
export function ViewerToolbar({
  state,
  zoom,
  viewports,
  variants,
  revisions,
  pinMode,
  canPin,
  onChange,
  onPinMode,
}: {
  state: ViewerState;
  /** The scale in effect: what Fit works out to, or the chosen one. */
  zoom: number;
  viewports: readonly ViewportPreset[];
  variants: readonly number[];
  /** The revisions of the variant in view, newest first. */
  revisions: readonly DesignRevisionView[];
  pinMode: boolean;
  /** Pins need an operator and a revision in view. */
  canPin: boolean;
  onChange: (change: ViewerChange) => void;
  onPinMode: (on: boolean) => void;
}) {
  // The typed width commits on Enter or blur, not on every keystroke.
  const [width, setWidth] = useState(String(state.width));
  useEffect(() => setWidth(String(state.width)), [state.width]);
  const commitWidth = () => {
    const n = Number(width);
    if (Number.isFinite(n) && n > 0 && Math.round(n) !== state.width) {
      onChange({ kind: 'width', width: n });
    } else {
      setWidth(String(state.width));
    }
  };

  return (
    <div
      role="toolbar"
      aria-label="Mockup view"
      className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2"
    >
      {/* Three groups: when the row runs out of room a whole group wraps, never a lone Pin (#399). */}
      <div data-toolbar-group="view" className="flex items-center gap-2">
        <SegmentedControl size="sm" role="group" aria-label="Viewport">
          {viewports.map((vp) => {
            const active = vp.name === state.viewport.name;
            return (
              <SegmentedControlItem
                key={vp.name}
                active={active}
                layoutId="design-viewport"
              >
                <button
                  type="button"
                  aria-pressed={active}
                  title={`${vp.width} × ${vp.height}`}
                  className="px-2 py-1 text-xs whitespace-nowrap"
                  onClick={() => onChange({ kind: 'viewport', viewport: vp })}
                >
                  {vp.name}
                </button>
              </SegmentedControlItem>
            );
          })}
        </SegmentedControl>

        <span className="flex items-center gap-1 text-xs text-ink-2">
          <NumberInput
            aria-label="Width in pixels"
            className="h-8 w-20 text-xs"
            min={DESIGN_VIEWPORT_MIN_PX}
            max={DESIGN_VIEWPORT_MAX_PX}
            value={width}
            onChange={(e) => setWidth(e.target.value)}
            onBlur={commitWidth}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitWidth();
            }}
          />
          <span aria-hidden="true">× {state.viewport.height}</span>
        </span>
      </div>

      <fieldset
        data-toolbar-group="zoom"
        className="m-0 flex items-center gap-1 border-0 p-0"
        title="Ctrl/⌘ + wheel, or Ctrl/⌘ + 0 − =, over the stage or the mockup"
      >
        <legend className="sr-only">Zoom</legend>
        <Button
          size="sm"
          icon
          variant="ghost"
          aria-label="Zoom out"
          disabled={zoom <= ZOOM_MIN}
          onClick={() => onChange({ kind: 'zoom', zoom: stepZoom(zoom, -1) })}
        >
          <Minus aria-hidden="true" className="size-4" />
        </Button>
        <SegmentedControl size="sm" role="group" aria-label="Zoom level">
          <SegmentedControlItem
            active={state.zoom === 'fit'}
            layoutId="design-zoom"
          >
            <button
              type="button"
              aria-pressed={state.zoom === 'fit'}
              className="px-2 py-1 text-xs whitespace-nowrap tabular-nums"
              onClick={() => onChange({ kind: 'zoom', zoom: 'fit' })}
            >
              {state.zoom === 'fit' ? `Fit · ${zoomPercent(zoom)}` : 'Fit'}
            </button>
          </SegmentedControlItem>
          {ZOOM_PRESETS.map((preset) => {
            const active = state.zoom === preset;
            return (
              <SegmentedControlItem
                key={preset}
                active={active}
                layoutId="design-zoom"
              >
                <button
                  type="button"
                  aria-pressed={active}
                  className="px-2 py-1 text-xs tabular-nums"
                  onClick={() => onChange({ kind: 'zoom', zoom: preset })}
                >
                  {Math.round(preset * 100)}%
                </button>
              </SegmentedControlItem>
            );
          })}
        </SegmentedControl>
        <Button
          size="sm"
          icon
          variant="ghost"
          aria-label="Zoom in"
          disabled={zoom >= ZOOM_MAX}
          onClick={() => onChange({ kind: 'zoom', zoom: stepZoom(zoom, 1) })}
        >
          <Plus aria-hidden="true" className="size-4" />
        </Button>
        {/* Off a preset (a step, the wheel): say where it is. */}
        {state.zoom !== 'fit' &&
        !(ZOOM_PRESETS as readonly number[]).includes(state.zoom) ? (
          <span className="text-xs text-ink-2 tabular-nums">
            {zoomPercent(zoom)}
          </span>
        ) : null}
      </fieldset>

      <div data-toolbar-group="review" className="flex items-center gap-2">
        <SegmentedControl size="sm" role="group" aria-label="Theme">
          {DESIGN_THEMES.map((theme) => (
            <SegmentedControlItem
              key={theme}
              active={state.theme === theme}
              layoutId="design-theme"
            >
              <button
                type="button"
                aria-pressed={state.theme === theme}
                className="px-2 py-1 text-xs"
                onClick={() => onChange({ kind: 'theme', theme })}
              >
                {THEME_LABEL[theme]}
              </button>
            </SegmentedControlItem>
          ))}
        </SegmentedControl>

        {variants.length > 1 ? (
          <Select
            aria-label="Variant"
            className="h-8 w-auto text-xs"
            value={state.variant}
            onChange={(e) =>
              onChange({ kind: 'variant', variant: Number(e.target.value) })
            }
          >
            {variants.map((v) => (
              <option key={v} value={v}>
                Variant {v}
              </option>
            ))}
          </Select>
        ) : null}

        {revisions.length > 0 ? (
          <Select
            aria-label="Revision"
            className="h-8 w-auto text-xs"
            value={state.revision?.id ?? ''}
            onChange={(e) =>
              onChange({ kind: 'revision', revisionId: e.target.value })
            }
          >
            {revisions.map((r, i) => (
              <option key={r.id} value={r.id}>
                {revisionLabel(r.variant, r.revision)}
                {i === 0 ? ' (latest)' : ''}
              </option>
            ))}
          </Select>
        ) : null}

        <Button
          size="sm"
          // Glass either way: the screen's one solid is Approve.
          variant="glass"
          // An outline, not a ring: glass draws its own box-shadow.
          className={
            pinMode ? 'outline-2 outline-offset-1 outline-accent' : undefined
          }
          aria-pressed={pinMode}
          disabled={!canPin}
          title={
            canPin
              ? 'Click the mockup to pin a comment to a point'
              : 'Pins need an operator and a drawn mockup.'
          }
          onClick={() => onPinMode(!pinMode)}
        >
          <Crosshair aria-hidden="true" className="size-4" />
          Pin
        </Button>
      </div>
    </div>
  );
}

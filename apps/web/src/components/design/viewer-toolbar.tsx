'use client';

import { Select } from '@andrewbehma/glass-ui/field';
import {
  SegmentedControl,
  SegmentedControlItem,
} from '@andrewbehma/glass-ui/segmented-control';
import {
  DESIGN_THEMES,
  type DesignRevisionView,
  type DesignTheme,
} from '@nautelle/shared';
import { revisionLabel } from '../../lib/design/format';
import type { ViewerChange, ViewerState } from '../../lib/design/viewer-state';

const THEME_LABEL: Record<DesignTheme, string> = {
  light: 'Light',
  dark: 'Dark',
};

/**
 * Theme, variant and revision: the toolbar's review group on a desktop, the
 * "View" section of the review sheet below `lg`.
 */
export function ViewControls({
  state,
  variants,
  revisions,
  onChange,
  touch = false,
}: {
  state: ViewerState;
  variants: readonly number[];
  revisions: readonly DesignRevisionView[];
  onChange: (change: ViewerChange) => void;
  /** 44px controls. */
  touch?: boolean;
}) {
  const field = touch ? 'h-11 w-auto text-sm' : 'h-8 w-auto text-xs';
  return (
    <>
      <SegmentedControl
        size={touch ? 'md' : 'sm'}
        role="group"
        aria-label="Theme"
      >
        {DESIGN_THEMES.map((theme) => (
          <SegmentedControlItem
            key={theme}
            active={state.theme === theme}
            layoutId="design-theme"
          >
            <button
              type="button"
              aria-pressed={state.theme === theme}
              className={
                touch ? 'min-h-(--size-tap) px-3 text-sm' : 'px-2 py-1 text-xs'
              }
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
          className={field}
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
          className={field}
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
    </>
  );
}

/**
 * The viewer's toolbar (spec 223 D11, #886): light/dark, the variant and the
 * revision, beside the frame tabs on a desktop. The devices are all on the
 * canvas and the canvas has its own zoom, so the toolbar has no viewport
 * switch, typed width or zoom; Comment is a canvas tool. Every choice is a
 * `ViewerChange`; the page keeps them in the URL.
 */
export function ViewerToolbar({
  state,
  variants,
  revisions,
  onChange,
}: {
  state: ViewerState;
  variants: readonly number[];
  /** The revisions of the variant in view, newest first. */
  revisions: readonly DesignRevisionView[];
  onChange: (change: ViewerChange) => void;
}) {
  return (
    <div
      role="toolbar"
      aria-label="Mockup view"
      className="flex shrink-0 flex-wrap items-center gap-2"
    >
      <ViewControls
        state={state}
        variants={variants}
        revisions={revisions}
        onChange={onChange}
      />
    </div>
  );
}

import {
  DEFAULT_VIEWPORTS,
  DESIGN_THEMES,
  type DesignFrameView,
  type DesignRevisionView,
  type DesignTheme,
  type TaskDesignView,
  type ViewportPreset,
} from '@nautelle/shared';
import type { Point } from '../canvas/geometry';
import { clampZoom, type Zoom } from './zoom';

/**
 * The viewer's state (spec 223 D11, #886), all of it in the URL so a link
 * opens the same view:
 * `?variant=2&rev=<revisionId>&frame=1&device=Tablet&theme=dark&zoom=0.5&pan=120,-40`.
 * Anything missing or wrong falls back to a default rather than failing; the
 * `vp` and `w` of the single-frame viewer are ignored.
 */
export interface ViewerState {
  variant: number;
  /** The revision in view; null while the design has none. */
  revision: DesignRevisionView | null;
  /**
   * #441: the frame in view — the tab — by position: `frame`, clamped to the
   * revision's frames, else the first.
   */
  frame: number;
  /** #886: the devices every frame is drawn at, side by side, in order. */
  devices: readonly ViewportPreset[];
  /**
   * The device a screen comment names: `device`, else the first. Selecting
   * a comment or dropping a pin moves it.
   */
  device: ViewportPreset;
  theme: DesignTheme;
  /** `zoom`: `fit` (Fit all, the default) or a scale such as 0.75 (spec 335 D4). */
  zoom: Zoom;
  /** `pan`: where the canvas's origin sits, in stage px; read only while `zoom` is a number. */
  pan: Point;
}

/** The URL keys, so a link and the parser agree. */
export const VIEWER_PARAM = {
  variant: 'variant',
  revision: 'rev',
  frame: 'frame',
  device: 'device',
  theme: 'theme',
  zoom: 'zoom',
  pan: 'pan',
} as const;

/** The single-frame viewer's preset and typed width (before #886): dropped on any change. */
const LEGACY_PARAMS = ['vp', 'w'] as const;

/** A zoom's longest spelling in a link: `0.123456` is already past any use. */
const ZOOM_PARAM_MAX = 8;
/** A pan's longest spelling: `-123456,-123456`. */
const PAN_PARAM_MAX = 15;
/** Past this a pan shows nothing of the canvas; such a link falls back to the origin. */
const PAN_MAX_PX = 100_000;

/**
 * `zoom=fit`, a number clamped to the bounds, anything else is Fit. WI-61:
 * the length is checked first, and the pattern cannot split a run of digits
 * two ways.
 */
export function parseZoom(raw: string | null): Zoom {
  if (
    raw === null ||
    raw.length > ZOOM_PARAM_MAX ||
    !/^(?:\d+|\d*\.\d+)$/.test(raw)
  ) {
    return 'fit';
  }
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? clampZoom(n) : 'fit';
}

const ORIGIN: Point = { x: 0, y: 0 };

/** `pan=x,y` in whole stage px; anything else is the origin. */
export function parsePan(raw: string | null): Point {
  if (raw === null || raw.length > PAN_PARAM_MAX) return ORIGIN;
  const match = /^(-?\d+),(-?\d+)$/.exec(raw);
  if (!match) return ORIGIN;
  const x = Number(match[1]);
  const y = Number(match[2]);
  return Math.abs(x) <= PAN_MAX_PX && Math.abs(y) <= PAN_MAX_PX
    ? { x, y }
    : ORIGIN;
}

/**
 * #886: the devices a design is shown at — the ones stored on it at its
 * latest Generate (#863), else the project's presets, else the built-in
 * devices. A revision drawn before devices were stored opens with the
 * project's presets.
 */
export const devicesOf = (
  design: Pick<TaskDesignView, 'devices' | 'viewports'>,
): readonly ViewportPreset[] =>
  design.devices && design.devices.length > 0
    ? design.devices
    : design.viewports.length > 0
      ? design.viewports
      : DEFAULT_VIEWPORTS;

const isTheme = (value: string | null): value is DesignTheme =>
  value !== null && (DESIGN_THEMES as readonly string[]).includes(value);

/**
 * The variants still in play, ascending: those with a revision that is not
 * archived (D4 archives the ones not picked). A design whose every revision
 * is archived — none should be — shows them all rather than nothing.
 */
export function variantsOf(revisions: readonly DesignRevisionView[]): number[] {
  const live = revisions.filter((r) => !r.archived);
  const from = live.length > 0 ? live : revisions;
  return [...new Set(from.map((r) => r.variant))].sort((a, b) => a - b);
}

/** One variant's revisions, newest first. */
export const revisionsOf = (
  revisions: readonly DesignRevisionView[],
  variant: number,
): DesignRevisionView[] =>
  revisions
    .filter((r) => r.variant === variant)
    .sort((a, b) => b.revision - a.revision);

const positiveInt = (raw: string | null): number | null => {
  if (raw === null || !/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};

/** #441: the frame in view of a state, or null with no revision. */
export const frameOf = (state: ViewerState): DesignFrameView | null =>
  state.revision?.frames[state.frame] ?? null;

export function resolveViewerState(
  params: URLSearchParams,
  revisions: readonly DesignRevisionView[],
  devices: readonly ViewportPreset[],
): ViewerState {
  const shown = devices.length > 0 ? devices : DEFAULT_VIEWPORTS;
  const variants = variantsOf(revisions);

  // A revision named in the URL wins: it also fixes the variant.
  const named = revisions.find(
    (r) => r.id === params.get(VIEWER_PARAM.revision),
  );
  const asked = positiveInt(params.get(VIEWER_PARAM.variant));
  const variant =
    named?.variant ??
    (asked !== null && variants.includes(asked) ? asked : variants[0]) ??
    1;
  const revision = named ?? revisionsOf(revisions, variant)[0] ?? null;
  // `frame` is 0-based: `?frame=0` is the first, as is anything out of range.
  const rawFrame = params.get(VIEWER_PARAM.frame);
  const asFrame = rawFrame === '0' ? 0 : positiveInt(rawFrame);
  const frame =
    asFrame !== null && asFrame < (revision?.frames.length ?? 0) ? asFrame : 0;

  const device =
    shown.find((d) => d.name === params.get(VIEWER_PARAM.device)) ?? shown[0];
  const themeParam = params.get(VIEWER_PARAM.theme);
  const theme = isTheme(themeParam) ? themeParam : (shown[0].theme ?? 'light');
  const zoom = parseZoom(params.get(VIEWER_PARAM.zoom));

  return {
    variant,
    revision,
    frame,
    devices: shown,
    device,
    theme,
    zoom,
    pan: zoom === 'fit' ? ORIGIN : parsePan(params.get(VIEWER_PARAM.pan)),
  };
}

/** A change to the state, as the URL keys it touches. */
export type ViewerChange =
  | { kind: 'variant'; variant: number }
  | { kind: 'revision'; revisionId: string }
  | { kind: 'frame'; frame: number }
  | { kind: 'device'; device: string }
  | { kind: 'theme'; theme: DesignTheme }
  /** The canvas's zoom and pan, written together: a gesture reports both. */
  | { kind: 'view'; zoom: Zoom; pan: Point }
  /**
   * #886: where a comment was left — its revision, tab, device and theme —
   * so selecting it opens that view. A null device or theme keeps the one
   * in view.
   */
  | {
      kind: 'place';
      revisionId: string;
      frame: number;
      device: string | null;
      theme: DesignTheme | null;
    };

const setFrame = (params: URLSearchParams, frame: number) => {
  // The first frame is the default: it leaves the URL clean.
  if (frame <= 0) params.delete(VIEWER_PARAM.frame);
  else params.set(VIEWER_PARAM.frame, String(Math.floor(frame)));
};

/**
 * The next query string. Choosing a variant drops the revision it replaces:
 * a variant shows its latest revision. The tab stays: the revisions of a
 * variant usually share frames, and one past the end reads as the first.
 */
export function applyViewerChange(
  params: URLSearchParams,
  change: ViewerChange,
): string {
  const next = new URLSearchParams(params);
  for (const key of LEGACY_PARAMS) next.delete(key);
  switch (change.kind) {
    case 'variant':
      next.set(VIEWER_PARAM.variant, String(change.variant));
      next.delete(VIEWER_PARAM.revision);
      break;
    case 'revision':
      next.set(VIEWER_PARAM.revision, change.revisionId);
      next.delete(VIEWER_PARAM.variant);
      break;
    case 'frame':
      setFrame(next, change.frame);
      break;
    case 'device':
      next.set(VIEWER_PARAM.device, change.device);
      break;
    case 'theme':
      next.set(VIEWER_PARAM.theme, change.theme);
      break;
    case 'view':
      // Fit all is the default and has no pan: it leaves the URL clean.
      if (change.zoom === 'fit') {
        next.delete(VIEWER_PARAM.zoom);
        next.delete(VIEWER_PARAM.pan);
      } else {
        next.set(VIEWER_PARAM.zoom, String(clampZoom(change.zoom)));
        next.set(
          VIEWER_PARAM.pan,
          `${Math.round(change.pan.x)},${Math.round(change.pan.y)}`,
        );
      }
      break;
    case 'place':
      next.set(VIEWER_PARAM.revision, change.revisionId);
      next.delete(VIEWER_PARAM.variant);
      setFrame(next, change.frame);
      if (change.device !== null) {
        next.set(VIEWER_PARAM.device, change.device);
      }
      if (change.theme !== null) next.set(VIEWER_PARAM.theme, change.theme);
      break;
  }
  const query = next.toString();
  return query ? `?${query}` : '';
}

import {
  DESIGN_VIEWPORT_MAX_PX,
  DESIGN_VIEWPORT_MIN_PX,
} from '@agentdock/shared';

/**
 * The viewer's zoom (spec 335): the mockup keeps its layout width and is
 * only drawn scaled. `fit` is the default — the whole width in the stage,
 * never above 100 %.
 */
export type Zoom = 'fit' | number;

export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 2;
/** The ± buttons and the keys step by 10 %. */
export const ZOOM_STEP = 0.1;
export const ZOOM_PRESETS = [0.5, 0.75, 1, 1.25] as const;

/** The side gutter `ResizableFrame` keeps on each side of its box, in px. */
export const FRAME_GUTTER_PX = 12;

/** D3: whole percents inside [25 %, 200 %]. */
export const clampZoom = (zoom: number): number =>
  Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(zoom * 100) / 100));

/**
 * D2: the zoom at which `frameWidth` fits in `available` px. Rounded down so
 * the frame never overflows by a rounding error, and never above 100 %.
 */
export function fitZoom(available: number, frameWidth: number): number {
  if (!(available > 0) || !(frameWidth > 0)) return 1;
  return clampZoom(Math.floor(Math.min(1, available / frameWidth) * 100) / 100);
}

/** The scale in effect: Fit is worked out from the stage, a number is itself. */
export const effectiveZoom = (
  zoom: Zoom,
  available: number,
  frameWidth: number,
): number => (zoom === 'fit' ? fitZoom(available, frameWidth) : zoom);

/** D3: a ± step from the zoom in effect, on whole percents. */
export const stepZoom = (current: number, direction: 1 | -1): number =>
  clampZoom(Math.round(current * 100 + direction * ZOOM_STEP * 100) / 100);

/** D3: Ctrl + wheel is proportional to the wheel's travel, and clamped. */
export const wheelZoom = (current: number, deltaY: number): number => {
  const travel = Math.min(100, Math.max(-100, deltaY));
  return clampZoom(current * Math.exp(-travel / 400));
};

/** "72 %". */
export const zoomPercent = (zoom: number): string =>
  `${Math.round(zoom * 100)} %`;

/**
 * D5: a width read off the scaled box is a layout width after dividing by the
 * zoom, so a drag of Δ screen px on the box is Δ/z layout px and the typed
 * width stays the layout width.
 */
export const layoutWidth = (boxWidth: number, zoom: number): number =>
  Math.min(
    DESIGN_VIEWPORT_MAX_PX,
    Math.max(DESIGN_VIEWPORT_MIN_PX, Math.round(boxWidth / zoom)),
  );

/** The scaled box's size for a layout size (D1). */
export const boxSize = (layout: number, zoom: number): number =>
  Math.round(layout * zoom);

/**
 * A drag of the frame's edge, until it is committed: the layout width it has
 * reached and the zoom it is read at.
 */
export interface FrameDrag {
  width: number;
  zoom: number;
}

/**
 * #394: the zoom the frame is drawn at. A drag holds the zoom it started at —
 * Fit worked out from the width being dragged would shrink the scale as the
 * width grows, so the box would stay put while the layout width ran away.
 */
export const frameZoom = (
  zoom: Zoom,
  available: number,
  width: number,
  drag: FrameDrag | null,
): number => drag?.zoom ?? effectiveZoom(zoom, available, width);

/** #394: a box width the frame reports during a drag, as the drag's layout width. */
export const dragStep = (
  drag: FrameDrag | null,
  box: number,
  zoom: number,
): FrameDrag => {
  const held = drag?.zoom ?? zoom;
  return { width: layoutWidth(box, held), zoom: held };
};

/**
 * D5: where a click was, in the page's viewport. `frame` is the scaled
 * bounding box; the click's place inside the mockup is in unscaled CSS px, so
 * it is scaled before it is added. A helper that sends no position (one
 * served before it did) anchors at the frame's top edge.
 */
export const anchorAt = (
  pin: { clientX?: number; clientY?: number },
  frame: { left: number; top: number; width: number },
  zoom: number,
): { left: number; top: number } =>
  pin.clientX !== undefined && pin.clientY !== undefined
    ? {
        left: frame.left + pin.clientX * zoom,
        top: frame.top + pin.clientY * zoom,
      }
    : { left: frame.left + frame.width / 2, top: frame.top };

/** What a stage key press asks for (D6), or null when it is not ours. */
export type ZoomKey = 'fit' | 'in' | 'out';

export function zoomKey(event: {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}): ZoomKey | null {
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return null;
  switch (event.key) {
    case '0':
      return 'fit';
    case '-':
    case '_':
      return 'out';
    case '=':
    case '+':
      return 'in';
    default:
      return null;
  }
}

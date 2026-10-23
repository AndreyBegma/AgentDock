/**
 * The viewer's zoom (spec 335): the mockup keeps its layout size and is only
 * drawn scaled. `fit` is the default — #886: every device on the canvas,
 * never above 100 %.
 */
export type Zoom = 'fit' | number;

export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 2;
/** The ± buttons and the keys step by 10 %. */
export const ZOOM_STEP = 0.1;

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

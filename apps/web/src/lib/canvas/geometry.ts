import { clampZoom, fitZoom, wheelZoom } from '../design/zoom';

/**
 * The frame canvas's geometry (#866). The world is a row of frames at their
 * own sizes; the stage draws it at `scale` with its origin at `pan`, in the
 * stage's own px. The zoom range and steps are the viewer's (spec 335).
 */
export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

/** What the stage shows: the scale in effect and where the world's origin is. */
export interface CanvasView {
  scale: number;
  pan: Point;
}

export interface CanvasFrameSize extends Size {
  id: string;
}

/** A frame placed in the world, in world (unscaled) px. */
export interface FrameBox extends CanvasFrameSize {
  left: number;
  top: number;
}

export interface CanvasLayout {
  boxes: FrameBox[];
  size: Size;
}

/** The gap between two frames of the row, in world px. */
export const CANVAS_GAP_PX = 80;
/** The room Fit all keeps on every side of the row, in stage px. */
export const CANVAS_MARGIN_PX = 32;
/** The band above the row that the labels take, in stage px (labels do not scale). */
export const CANVAS_LABEL_PX = 28;

/** A frame's label: "Phone · 390×844". */
export const frameLabel = (frame: Size & { name: string }): string =>
  `${frame.name} · ${frame.width}×${frame.height}`;

/** The frames side by side, top-aligned, `gap` apart. */
export function layoutRow(
  frames: readonly CanvasFrameSize[],
  gap = CANVAS_GAP_PX,
): CanvasLayout {
  let left = 0;
  let height = 0;
  const boxes = frames.map((frame) => {
    const box = { ...frame, left, top: 0 };
    left += frame.width + gap;
    height = Math.max(height, frame.height);
    return box;
  });
  return {
    boxes,
    size: { width: Math.max(0, left - gap), height },
  };
}

/**
 * The scale at which the whole row, its labels and the margins fit in the
 * stage: the tighter of the width and the height fit, on the viewer's whole
 * percents, never above 100 % and never below the minimum zoom.
 */
export function fitAll(stage: Size, world: Size): number {
  return Math.min(
    fitZoom(stage.width - 2 * CANVAS_MARGIN_PX, world.width),
    fitZoom(
      stage.height - 2 * CANVAS_MARGIN_PX - CANVAS_LABEL_PX,
      world.height,
    ),
  );
}

/** The pan that centres the row (with its label band) in the stage at `scale`. */
export function centredPan(stage: Size, world: Size, scale: number): Point {
  const height = CANVAS_LABEL_PX + world.height * scale;
  return {
    x: (stage.width - world.width * scale) / 2,
    y: (stage.height - height) / 2 + CANVAS_LABEL_PX,
  };
}

/** Fit all: the fitted scale, centred. */
export function fitView(stage: Size, world: Size): CanvasView {
  const scale = fitAll(stage, world);
  return { scale, pan: centredPan(stage, world, scale) };
}

/** A stage point (px from the stage's top-left) in world px. */
export const toWorld = (view: CanvasView, point: Point): Point => ({
  x: (point.x - view.pan.x) / view.scale,
  y: (point.y - view.pan.y) / view.scale,
});

/**
 * The view at `scale` with `anchor` (a stage point) kept over the same world
 * point: zooming around the pointer, or around the stage's centre for the
 * buttons. The scale is clamped first.
 */
export function zoomAround(
  view: CanvasView,
  scale: number,
  anchor: Point,
): CanvasView {
  const next = clampZoom(scale);
  const ratio = next / view.scale;
  return {
    scale: next,
    pan: {
      x: anchor.x - (anchor.x - view.pan.x) * ratio,
      y: anchor.y - (anchor.y - view.pan.y) * ratio,
    },
  };
}

/** The frame under a world point, or null over empty space. */
export const frameAt = (
  boxes: readonly FrameBox[],
  point: Point,
): FrameBox | null =>
  boxes.find(
    (box) =>
      point.x >= box.left &&
      point.x <= box.left + box.width &&
      point.y >= box.top &&
      point.y <= box.top + box.height,
  ) ?? null;

/**
 * A pointer in a frame's own px at the scale in effect — where a pin is
 * stored. `stage` is the stage's client rect. Null when the pointer is outside
 * the frame.
 */
export function pointInFrame(
  pointer: { clientX: number; clientY: number },
  stage: { left: number; top: number },
  view: CanvasView,
  box: FrameBox,
): Point | null {
  const world = toWorld(view, {
    x: pointer.clientX - stage.left,
    y: pointer.clientY - stage.top,
  });
  if (frameAt([box], world) === null) return null;
  return { x: world.x - box.left, y: world.y - box.top };
}

/**
 * Ctrl/⌘ + wheel (spec 335, D3) with the travel kept until it moves the zoom:
 * the zoom is on whole percents, so a trackpad pinch's small deltas would
 * each round back to the scale they started from.
 */
export function wheelStep(
  scale: number,
  pending: number,
  deltaY: number,
): { scale: number; pending: number } {
  const travel = pending + deltaY;
  const next = wheelZoom(scale, travel);
  return next === scale
    ? { scale, pending: travel }
    : { scale: next, pending: 0 };
}

/** A touch pinch: two pointers, where they started and where they are. */
export interface Pinch {
  view: CanvasView;
  centre: Point;
  distance: number;
}

/**
 * The view during a pinch: scaled by the change in distance around where the
 * pinch began, and moved with its centre, so the two fingers stay on the same
 * world points.
 */
export function pinchView(
  start: Pinch,
  centre: Point,
  distance: number,
): CanvasView {
  if (!(start.distance > 0)) return start.view;
  const zoomed = zoomAround(
    start.view,
    (start.view.scale * distance) / start.distance,
    start.centre,
  );
  return {
    scale: zoomed.scale,
    pan: {
      x: zoomed.pan.x + centre.x - start.centre.x,
      y: zoomed.pan.y + centre.y - start.centre.y,
    },
  };
}

/** The centre and spread of two pointers. */
export const pinchOf = (
  a: Point,
  b: Point,
): { centre: Point; distance: number } => ({
  centre: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
  distance: Math.hypot(a.x - b.x, a.y - b.y),
});

import { type CSSProperties, useSyncExternalStore } from 'react';
import type { Point, Size } from './geometry';

/**
 * #907: how a mockup's frame is drawn at a scale. A mockup's iframe is
 * sandboxed without `allow-same-origin`, so Chromium renders it in a process
 * of its own; under an ancestor `transform: scale()` that process gets its
 * backdrop filters' rectangles wrong — glass torn into bands, shadows that
 * jump while the canvas pans. CSS `zoom` reaches into the iframe instead: the
 * mockup keeps its viewport, is drawn at the size it is shown at, and its
 * glass is clean. Where `zoom` does not reach into a frame (the probe below),
 * the frame is scaled with a transform, as before.
 */

/** A length in CSS px on the nearest device pixel, so a layer's edges stay crisp. */
export const snapToDevice = (value: number, dpr: number): number => {
  const ratio = dpr > 0 && Number.isFinite(dpr) ? dpr : 1;
  return Math.round(value * ratio) / ratio;
};

/** How a box laid out in frame px is drawn at `scale` (a preview, a compare cell). */
export const scaledBox = (scale: number, byZoom: boolean): CSSProperties =>
  byZoom
    ? { zoom: scale }
    : { transform: `scale(${scale})`, transformOrigin: 'top left' };

/** The canvas's styles at a view: its world, each frame and each frame's label. */
export interface CanvasDrawing {
  /** The layer every frame is in, moved to the pan. */
  world: CSSProperties;
  /** Each frame, laid out in frame px. */
  frame: CSSProperties;
  /** A frame's label, drawn back at 1 / scale so it keeps its size on screen. */
  caption: CSSProperties;
}

/**
 * FrameCanvas at `scale` with its origin at `pan`. The pan is snapped to the
 * device pixel; with `byZoom` the world only moves and every frame is zoomed,
 * otherwise the world is scaled as a whole.
 */
export function canvasDrawing(
  scale: number,
  pan: Point,
  world: Size,
  byZoom: boolean,
  dpr: number,
): CanvasDrawing {
  const x = snapToDevice(pan.x, dpr);
  const y = snapToDevice(pan.y, dpr);
  const back = 1 / scale;
  return byZoom
    ? {
        world: {
          width: world.width * scale,
          height: world.height * scale,
          transform: `translate3d(${x}px, ${y}px, 0)`,
        },
        frame: { zoom: scale },
        caption: { zoom: back },
      }
    : {
        world: {
          width: world.width,
          height: world.height,
          transform: `translate(${x}px, ${y}px) scale(${scale})`,
        },
        frame: {},
        caption: { transform: `scale(${back})` },
      };
}

const PROBE_PX = 200;

/** The bits of a document the probe uses, so a test can hand it a stand-in. */
export interface ProbeDocument {
  createElement(tag: 'iframe'): {
    style: { cssText: string };
    setAttribute(name: string, value: string): void;
    readonly contentWindow: { innerWidth: number } | null;
    remove(): void;
  };
  body: { append(node: unknown): void };
}

/**
 * Whether `zoom` on an iframe zooms the document inside it: a frame laid out
 * 200 px wide at zoom 0.5 still has a 200 px viewport when it does, and a
 * 100 px one when it does not.
 */
export function probeZoomReach(doc: ProbeDocument): boolean {
  const probe = doc.createElement('iframe');
  probe.setAttribute('aria-hidden', 'true');
  probe.setAttribute('tabindex', '-1');
  probe.style.cssText = `position:fixed;top:0;left:0;width:${PROBE_PX}px;height:1px;border:0;visibility:hidden;pointer-events:none;zoom:0.5`;
  doc.body.append(probe);
  try {
    return probe.contentWindow?.innerWidth === PROBE_PX;
  } finally {
    probe.remove();
  }
}

let reaches: boolean | undefined;
const zoomReachesFrames = (): boolean => {
  reaches ??= probeZoomReach(document);
  return reaches;
};
const unchanging = () => () => {};

/** Whether frames are drawn with `zoom`; false on the server, probed once in the browser. */
export const useZoomReachesFrames = (): boolean =>
  useSyncExternalStore(unchanging, zoomReachesFrames, () => false);

/** Re-armed on every change: a media query names the ratio it was made for. */
function subscribeRatio(onChange: () => void): () => void {
  let query: MediaQueryList | null = null;
  const fire = () => {
    arm();
    onChange();
  };
  const arm = () => {
    query?.removeEventListener('change', fire);
    query = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    query.addEventListener('change', fire);
  };
  arm();
  return () => query?.removeEventListener('change', fire);
}

/** The device pixel ratio, kept current across moving to another screen and browser zoom; 1 on the server. */
export const useDevicePixelRatio = (): number =>
  useSyncExternalStore(
    subscribeRatio,
    () => window.devicePixelRatio,
    () => 1,
  );

'use client';

import { Button } from '@andrewbehma/glass-ui/button';
import { Separator } from '@andrewbehma/glass-ui/separator';
import { Maximize, Minus, Plus } from 'lucide-react';
import {
  createContext,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  CANVAS_GAP_PX,
  type CanvasView,
  centreOn,
  fitView,
  frameAt,
  frameLabel,
  layoutRow,
  type Pinch,
  type Point,
  pinchOf,
  pinchView,
  pointInFrame,
  type Size,
  toWorld,
  wheelStep,
  zoomAround,
} from '../../lib/canvas/geometry';
import {
  clampZoom,
  stepZoom,
  ZOOM_MAX,
  ZOOM_MIN,
  type Zoom,
  zoomKey,
  zoomPercent,
} from '../../lib/design/zoom';

/** One frame of the row: drawn at its own size, labelled "Phone · 390×844". */
export interface CanvasFrame {
  id: string;
  name: string;
  width: number;
  height: number;
  /** A small glyph before the name in the label. */
  icon?: ReactNode;
  /** Draws the frame and its label in the accent. */
  active?: boolean;
  content: ReactNode;
}

export interface FrameCanvasProps {
  frames: readonly CanvasFrame[];
  /** `fit` is Fit all, worked out from the stage; a number is the scale. */
  zoom: Zoom;
  onZoomChange: (zoom: Zoom) => void;
  /** Where the world's origin is, in stage px. Ignored while `zoom` is `fit`. */
  pan: Point;
  onPanChange: (pan: Point) => void;
  /** Between two frames, in frame px. */
  gap?: number;
  /** The stage's accessible name. */
  label?: string;
  /** A glass group in the stage's top-left corner (a tool switch). */
  tools?: ReactNode;
  /**
   * #886: a point of a frame, in that frame's px, to bring to the middle of
   * the stage once it is measured — a comment's pin. It zooms in to at least
   * `FOCUS_MIN_SCALE` and is applied once per value.
   */
  focus?: CanvasFocus | null;
  /** Called once `focus` is applied (or names no frame), so the owner can drop it. */
  onFocused?: () => void;
  className?: string;
}

export interface CanvasFocus {
  frameId: string;
  point: Point;
}

/** The least scale a focused point is shown at, so a pin is legible. */
export const FOCUS_MIN_SCALE = 0.5;

/** What a frame's content (pins, a forwarded wheel) can ask the canvas. */
export interface FrameCanvasApi {
  /** The scale the frames are drawn at now. */
  scale: number;
  /** A pointer in the frame's own px at the current scale, or null outside it. */
  pointInFrame: (
    pointer: { clientX: number; clientY: number },
    frameId: string,
  ) => Point | null;
  /** The frame under a pointer and the point in it, or null over empty space. */
  frameAt: (pointer: {
    clientX: number;
    clientY: number;
  }) => { id: string; point: Point } | null;
  /**
   * Ctrl/⌘ + wheel a child could not let bubble (an iframe forwards it, spec
   * 396). Zooms around `at` when given, else around the stage's centre.
   */
  zoomByWheel: (
    deltaY: number,
    at?: { clientX: number; clientY: number },
  ) => void;
}

const FrameCanvasContext = createContext<FrameCanvasApi | null>(null);

/** The canvas around a frame's content, its tools or its pins. */
export function useFrameCanvas(): FrameCanvasApi {
  const api = useContext(FrameCanvasContext);
  if (!api) throw new Error('useFrameCanvas is used outside a FrameCanvas');
  return api;
}

/** The stage's content box, kept current by a `ResizeObserver`; 0 × 0 until measured. */
function useElementSize(): [
  HTMLElement | null,
  (el: HTMLElement | null) => void,
  Size,
] {
  const [element, setElement] = useState<HTMLElement | null>(null);
  const [size, setSize] = useState<Size>({ width: 0, height: 0 });
  const ref = useCallback((el: HTMLElement | null) => setElement(el), []);

  useEffect(() => {
    if (!element) return;
    const read = () =>
      setSize({ width: element.clientWidth, height: element.clientHeight });
    read();
    const observer = new ResizeObserver(read);
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);

  return [element, ref, size];
}

/** A wheel's travel in px, whatever unit the device reports it in. */
const LINE_PX = 16;
const wheelPx = (event: WheelEvent, delta: number): number =>
  event.deltaMode === 1
    ? delta * LINE_PX
    : event.deltaMode === 2
      ? delta * window.innerHeight
      : delta;

const INSIDE_FRAME = '[data-canvas-frame]';
const CHROME = '[data-canvas-chrome]';

/**
 * A pannable, zoomable canvas of frames in a row (#866, stack S-10), the way
 * Figma shows boards: drag empty space or scroll a trackpad to pan, Ctrl/⌘ +
 * wheel or pinch to zoom around the pointer, and Zoom out / in, Fit all and
 * 100 % in a glass group. The zoom range and steps are the viewer's (spec
 * 335); labels keep their on-screen size at any zoom.
 *
 * Zoom and pan are controlled, so a viewer can keep them in the URL; every
 * gesture reports both. A pointer pressed inside a frame never pans, so a
 * frame's own drags (an edge, spec 394) keep the pointer, and while it is down
 * Fit all holds the scale it started at.
 *
 * Composed from glass-ui (`Button`, `Separator`, `glass`) until glass-ui ships
 * the proposed canvas primitive with this API (docs/ui/glass-ui.md, "Missing
 * in glass-ui").
 */
export function FrameCanvas({
  frames,
  zoom,
  onZoomChange,
  pan,
  onPanChange,
  gap = CANVAS_GAP_PX,
  label = 'Canvas',
  tools,
  focus = null,
  onFocused,
  className = '',
}: FrameCanvasProps) {
  const [stage, stageRef, stageSize] = useElementSize();
  const layout = layoutRow(frames, gap);
  const fitted = fitView(stageSize, layout.size);
  // #394: a press inside a frame holds the fitted view until it is released.
  const [held, setHeld] = useState<CanvasView | null>(null);
  const view: CanvasView =
    zoom === 'fit' ? (held ?? fitted) : { scale: clampZoom(zoom), pan };
  const [grabbing, setGrabbing] = useState(false);

  // Gestures read the view through a ref: several events can arrive between
  // two renders, and each must build on the one before.
  const live = useRef({ view, onZoomChange, onPanChange });
  useEffect(() => {
    live.current = { view, onZoomChange, onPanChange };
  });

  const commit = useCallback((next: CanvasView) => {
    live.current.view = next;
    live.current.onZoomChange(next.scale);
    live.current.onPanChange(next.pan);
  }, []);

  const local = useCallback(
    (pointer: { clientX: number; clientY: number }): Point => {
      const rect = stage?.getBoundingClientRect();
      return {
        x: pointer.clientX - (rect?.left ?? 0),
        y: pointer.clientY - (rect?.top ?? 0),
      };
    },
    [stage],
  );

  const centre = useCallback(
    (): Point => ({
      x: (stage?.clientWidth ?? 0) / 2,
      y: (stage?.clientHeight ?? 0) / 2,
    }),
    [stage],
  );

  const pendingWheel = useRef(0);
  const zoomByWheel = useCallback(
    (deltaY: number, anchor: Point) => {
      const current = live.current.view;
      const step = wheelStep(current.scale, pendingWheel.current, deltaY);
      pendingWheel.current = step.pending;
      if (step.scale !== current.scale)
        commit(zoomAround(current, step.scale, anchor));
    },
    [commit],
  );

  // Not React's `onWheel`: that listener is passive, and only an active one
  // can stop the browser's own page zoom and scroll.
  useEffect(() => {
    if (!stage) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      if (event.ctrlKey || event.metaKey) {
        zoomByWheel(wheelPx(event, event.deltaY), local(event));
        return;
      }
      // Shift + a mouse wheel scrolls sideways.
      const sideways = event.shiftKey && event.deltaX === 0;
      const dx = wheelPx(event, sideways ? event.deltaY : event.deltaX);
      const dy = sideways ? 0 : wheelPx(event, event.deltaY);
      const current = live.current.view;
      commit({
        scale: current.scale,
        pan: { x: current.pan.x - dx, y: current.pan.y - dy },
      });
    };
    stage.addEventListener('wheel', onWheel, { passive: false });
    return () => stage.removeEventListener('wheel', onWheel);
  }, [stage, zoomByWheel, local, commit]);

  // Pointers down on empty space: one pans, two pinch.
  const pointers = useRef(new Map<number, Point>());
  const drag = useRef<{ origin: Point; view: CanvasView } | null>(null);
  const pinch = useRef<Pinch | null>(null);

  const restart = () => {
    const [a, b] = [...pointers.current.values()];
    if (a && b) {
      pinch.current = { view: live.current.view, ...pinchOf(a, b) };
      drag.current = null;
    } else {
      pinch.current = null;
      drag.current = a ? { origin: a, view: live.current.view } : null;
    }
    setGrabbing(pointers.current.size > 0);
  };

  const onPointerDownCapture = (event: PointerEvent<HTMLElement>) => {
    if (zoom !== 'fit' || !(event.target as Element).closest(INSIDE_FRAME))
      return;
    setHeld(live.current.view);
    const release = () => {
      setHeld(null);
      window.removeEventListener('pointerup', release);
      window.removeEventListener('pointercancel', release);
    };
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', release);
  };

  const onPointerDown = (event: PointerEvent<HTMLElement>) => {
    const target = event.target as Element;
    if (target.closest(INSIDE_FRAME) || target.closest(CHROME)) return;
    if (
      event.pointerType === 'mouse' &&
      event.button !== 0 &&
      event.button !== 1
    )
      return;
    event.currentTarget.setPointerCapture(event.pointerId);
    pointers.current.set(event.pointerId, local(event));
    restart();
  };

  const onPointerMove = (event: PointerEvent<HTMLElement>) => {
    if (!pointers.current.has(event.pointerId)) return;
    const point = local(event);
    pointers.current.set(event.pointerId, point);
    const [a, b] = [...pointers.current.values()];
    if (pinch.current && a && b) {
      const now = pinchOf(a, b);
      commit(pinchView(pinch.current, now.centre, now.distance));
    } else if (drag.current) {
      const { origin, view: from } = drag.current;
      commit({
        scale: from.scale,
        pan: {
          x: from.pan.x + point.x - origin.x,
          y: from.pan.y + point.y - origin.y,
        },
      });
    }
  };

  const onPointerUp = (event: PointerEvent<HTMLElement>) => {
    if (!pointers.current.delete(event.pointerId)) return;
    restart();
  };

  const measured = stageSize.width > 0 && stageSize.height > 0;

  // The layout and the stage are read through a ref: a focus is applied once,
  // when it arrives or the stage is first measured, not on every resize.
  const placed = useRef({ boxes: layout.boxes, stageSize, onFocused });
  useEffect(() => {
    placed.current = { boxes: layout.boxes, stageSize, onFocused };
  });
  useEffect(() => {
    if (!focus || !measured) return;
    const { boxes, stageSize: size, onFocused: done } = placed.current;
    const box = boxes.find((b) => b.id === focus.frameId);
    if (box) {
      commit(
        centreOn(
          size,
          { x: box.left + focus.point.x, y: box.top + focus.point.y },
          Math.max(live.current.view.scale, FOCUS_MIN_SCALE),
        ),
      );
    }
    done?.();
  }, [focus, measured, commit]);

  const zoomTo = (scale: number) => commit(zoomAround(view, scale, centre()));

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const key = zoomKey(event);
    if (!key) return;
    event.preventDefault();
    if (key === 'fit') onZoomChange('fit');
    else zoomTo(stepZoom(view.scale, key === 'in' ? 1 : -1));
  };

  const boxes = layout.boxes;
  const api: FrameCanvasApi = {
    scale: view.scale,
    pointInFrame: (pointer, frameId) => {
      const box = boxes.find((b) => b.id === frameId);
      const rect = stage?.getBoundingClientRect();
      return box && rect ? pointInFrame(pointer, rect, view, box) : null;
    },
    frameAt: (pointer) => {
      const point = toWorld(view, local(pointer));
      const box = frameAt(boxes, point);
      return box
        ? {
            id: box.id,
            point: { x: point.x - box.left, y: point.y - box.top },
          }
        : null;
    },
    zoomByWheel: (deltaY, at) => zoomByWheel(deltaY, at ? local(at) : centre()),
  };

  const { scale } = view;
  const hairline = 1 / scale;

  return (
    <FrameCanvasContext.Provider value={api}>
      <section
        ref={stageRef}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: the stage takes focus so the zoom keys have a place to act
        tabIndex={0}
        aria-label={label}
        data-grabbing={grabbing || undefined}
        onKeyDown={onKeyDown}
        onPointerDownCapture={onPointerDownCapture}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        className={`relative touch-none select-none overflow-hidden rounded-surface border border-line bg-surface outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent ${
          grabbing ? 'cursor-grabbing' : 'cursor-grab'
        } ${className}`}
        style={{
          backgroundImage:
            'radial-gradient(var(--color-line-strong) 1px, transparent 1.2px)',
          backgroundSize: '20px 20px',
          backgroundPosition: `${view.pan.x}px ${view.pan.y}px`,
        }}
      >
        <div
          className="absolute top-0 left-0 origin-top-left will-change-transform"
          style={{
            width: layout.size.width,
            height: layout.size.height,
            transform: `translate(${view.pan.x}px, ${view.pan.y}px) scale(${scale})`,
            visibility: measured || zoom !== 'fit' ? undefined : 'hidden',
          }}
        >
          {frames.map((frame, index) => {
            const box = boxes[index];
            if (!box) return null;
            return (
              <figure
                key={frame.id}
                aria-label={frameLabel(frame)}
                data-canvas-frame={frame.id}
                className="absolute m-0 cursor-auto"
                style={{
                  left: box.left,
                  top: box.top,
                  width: frame.width,
                  height: frame.height,
                }}
              >
                {/* Drawn at 1 / scale, so the label keeps its size on screen. */}
                <figcaption
                  aria-hidden="true"
                  className={`absolute bottom-full left-0 flex origin-bottom-left items-center gap-1.5 pb-2 text-xs whitespace-nowrap ${
                    frame.active ? 'text-accent-ink' : 'text-ink-2'
                  }`}
                  style={{ transform: `scale(${hairline})` }}
                >
                  {frame.icon ? (
                    <span className="flex size-3.5 items-center [&_svg]:size-3.5">
                      {frame.icon}
                    </span>
                  ) : null}
                  <span
                    className={
                      frame.active ? 'font-semibold' : 'font-semibold text-ink'
                    }
                  >
                    {frame.name}
                  </span>
                  <span className="text-ink-3 tabular-nums">
                    · {frame.width}×{frame.height}
                  </span>
                </figcaption>
                <div
                  className="relative size-full overflow-hidden bg-ground"
                  style={{
                    boxShadow: frame.active
                      ? `0 0 0 ${2 * hairline}px var(--color-accent)`
                      : `0 0 0 ${hairline}px var(--color-line-strong)`,
                  }}
                >
                  {frame.content}
                </div>
              </figure>
            );
          })}
        </div>
        {tools ? (
          <div
            data-canvas-chrome=""
            className="glass absolute top-3 left-3 z-10 flex items-center gap-0.5 rounded-surface p-1 cursor-auto"
          >
            {tools}
          </div>
        ) : null}
        <fieldset
          data-canvas-chrome=""
          className="glass absolute bottom-3 left-3 z-10 m-0 flex items-center gap-0.5 rounded-surface border-0 p-1 cursor-auto"
        >
          <legend className="sr-only">Zoom</legend>
          <Button
            icon
            variant="ghost"
            aria-label="Zoom out"
            disabled={scale <= ZOOM_MIN}
            onClick={() => zoomTo(stepZoom(scale, -1))}
          >
            <Minus aria-hidden="true" className="size-3.5" />
          </Button>
          <output
            aria-label="Zoom level"
            className="min-w-13 px-1 text-center text-xs text-ink-2 tabular-nums"
          >
            {zoomPercent(scale)}
          </output>
          <Button
            icon
            variant="ghost"
            aria-label="Zoom in"
            disabled={scale >= ZOOM_MAX}
            onClick={() => zoomTo(stepZoom(scale, 1))}
          >
            <Plus aria-hidden="true" className="size-3.5" />
          </Button>
          <Separator orientation="vertical" className="mx-1 h-4" />
          <Button
            variant="ghost"
            size="sm"
            aria-pressed={zoom === 'fit'}
            onClick={() => onZoomChange('fit')}
          >
            <Maximize aria-hidden="true" className="size-3.5" />
            Fit all
          </Button>
          <Button
            variant="ghost"
            size="sm"
            aria-pressed={zoom !== 'fit' && scale === 1}
            onClick={() => zoomTo(1)}
          >
            100%
          </Button>
        </fieldset>
      </section>
    </FrameCanvasContext.Provider>
  );
}

import { describe, expect, test } from 'bun:test';
import {
  canvasDrawing,
  type ProbeDocument,
  probeZoomReach,
  scaledBox,
  snapToDevice,
} from './frame-zoom';

describe('snapToDevice (#907)', () => {
  test('puts a length on the nearest device pixel', () => {
    expect(snapToDevice(10.3, 1)).toBe(10);
    expect(snapToDevice(10.3, 2)).toBe(10.5);
    expect(snapToDevice(10.2, 2)).toBe(10);
    expect(snapToDevice(-3.37, 2)).toBe(-3.5);
    expect(snapToDevice(1.1, 1.5)).toBeCloseTo(4 / 3);
  });

  test('takes a ratio it cannot use as 1', () => {
    expect(snapToDevice(10.6, 0)).toBe(11);
    expect(snapToDevice(10.6, Number.NaN)).toBe(11);
  });
});

describe('canvasDrawing (#907)', () => {
  const world = { width: 1910, height: 900 };

  test('with zoom, the world only moves and every frame is zoomed', () => {
    const drawing = canvasDrawing(1.5, { x: 40.3, y: 60.8 }, world, true, 2);
    // No scale anywhere above the frames: that is what tore the glass.
    expect(drawing.world.transform).toBe('translate3d(40.5px, 61px, 0)');
    expect(drawing.world.width).toBe(2865);
    expect(drawing.world.height).toBe(1350);
    expect(drawing.frame).toEqual({ zoom: 1.5 });
    expect(drawing.caption).toEqual({ zoom: 1 / 1.5 });
  });

  test('without it, the world is scaled as a whole, as before', () => {
    const drawing = canvasDrawing(0.5, { x: 12, y: 34.2 }, world, false, 1);
    expect(drawing.world).toEqual({
      width: 1910,
      height: 900,
      transform: 'translate(12px, 34px) scale(0.5)',
    });
    expect(drawing.frame).toEqual({});
    expect(drawing.caption).toEqual({ transform: 'scale(2)' });
  });
});

describe('scaledBox (#907)', () => {
  test('zooms where zoom reaches the frame, else scales from the top left', () => {
    expect(scaledBox(0.25, true)).toEqual({ zoom: 0.25 });
    expect(scaledBox(0.25, false)).toEqual({
      transform: 'scale(0.25)',
      transformOrigin: 'top left',
    });
  });
});

describe('probeZoomReach (#907)', () => {
  // A document whose iframe reports `innerWidth`, recording what it was given.
  const documentWith = (innerWidth: number | null) => {
    const seen = { css: '', appended: false, removed: false };
    const doc: ProbeDocument = {
      createElement: () => ({
        style: {
          get cssText() {
            return seen.css;
          },
          set cssText(value: string) {
            seen.css = value;
          },
        },
        setAttribute: () => {},
        contentWindow: innerWidth === null ? null : { innerWidth },
        remove: () => {
          seen.removed = true;
        },
      }),
      body: {
        append: () => {
          seen.appended = true;
        },
      },
    };
    return { doc, seen };
  };

  test('zoom reaches the frame when its viewport keeps the laid-out width', () => {
    const { doc, seen } = documentWith(200);
    expect(probeZoomReach(doc)).toBe(true);
    expect(seen.css).toContain('width:200px');
    expect(seen.css).toContain('zoom:0.5');
    expect(seen.appended).toBe(true);
    expect(seen.removed).toBe(true);
  });

  test('it does not when the viewport shrinks with the zoom', () => {
    expect(probeZoomReach(documentWith(100).doc)).toBe(false);
  });

  test('a frame without a window is not trusted to zoom', () => {
    const { doc, seen } = documentWith(null);
    expect(probeZoomReach(doc)).toBe(false);
    expect(seen.removed).toBe(true);
  });
});

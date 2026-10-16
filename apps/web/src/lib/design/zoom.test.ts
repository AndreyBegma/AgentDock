import { describe, expect, test } from 'bun:test';
import {
  anchorAt,
  boxSize,
  clampZoom,
  dragStep,
  effectiveZoom,
  type FrameDrag,
  fitZoom,
  frameZoom,
  layoutWidth,
  stepZoom,
  wheelZoom,
  type Zoom,
  zoomKey,
  zoomPercent,
} from './zoom';

describe('fitZoom', () => {
  test('a 1440 mockup on a 1000 px stage fits at 69 %', () => {
    expect(fitZoom(1000, 1440)).toBe(0.69);
  });

  test('never upscales: a 390 mockup on the same stage is 100 %', () => {
    expect(fitZoom(1000, 390)).toBe(1);
  });

  test('stays inside the bounds', () => {
    expect(fitZoom(100, 1440)).toBe(0.25);
    expect(fitZoom(0, 1440)).toBe(1);
    expect(fitZoom(1000, 0)).toBe(1);
  });

  test('effectiveZoom: fit is measured, a number is itself', () => {
    expect(effectiveZoom('fit', 1000, 1440)).toBe(0.69);
    expect(effectiveZoom(0.5, 1000, 1440)).toBe(0.5);
  });
});

describe('stepZoom', () => {
  test('50 → 40 → 50', () => {
    const down = stepZoom(0.5, -1);
    expect(down).toBe(0.4);
    expect(stepZoom(down, 1)).toBe(0.5);
  });

  test('steps from an off-grid Fit value and clamps', () => {
    expect(stepZoom(0.69, -1)).toBe(0.59);
    expect(stepZoom(0.25, -1)).toBe(0.25);
    expect(stepZoom(2, 1)).toBe(2);
  });
});

describe('wheelZoom', () => {
  test('wheel up zooms in, down zooms out, proportionally', () => {
    expect(wheelZoom(1, -100)).toBeGreaterThan(1);
    expect(wheelZoom(1, 100)).toBeLessThan(1);
    expect(wheelZoom(1, -10) - 1).toBeLessThan(wheelZoom(1, -100) - 1);
  });

  test('clamps, and one huge delta is capped', () => {
    expect(wheelZoom(1.9, -100000)).toBe(2);
    expect(wheelZoom(0.3, 100000)).toBe(0.25);
    expect(wheelZoom(1, -100000)).toBe(wheelZoom(1, -100));
  });

  test('a tiny delta rounds back to the same percent', () => {
    expect(wheelZoom(1, 1)).toBe(1);
  });
});

describe('clampZoom and zoomPercent', () => {
  test('whole percents inside [25, 200]', () => {
    expect(clampZoom(0.1)).toBe(0.25);
    expect(clampZoom(9)).toBe(2);
    expect(clampZoom(0.756)).toBe(0.76);
    expect(zoomPercent(0.72)).toBe('72 %');
  });
});

describe('edge drag (D5)', () => {
  test('at 50 %, 100 screen px on the box are 200 layout px', () => {
    const start = 800;
    const box = boxSize(start, 0.5) + 100;
    expect(layoutWidth(box, 0.5) - start).toBe(200);
  });

  test('at 100 % the box width is the layout width', () => {
    expect(layoutWidth(1024, 1)).toBe(1024);
  });

  test('the result is a clamped layout width', () => {
    expect(layoutWidth(1, 0.5)).toBeGreaterThanOrEqual(1);
    expect(layoutWidth(10_000_000, 0.5)).toBeLessThan(10_000_000);
  });
});

describe('a drag holds its zoom (#394)', () => {
  const AVAILABLE = 976;

  /**
   * One drag, replayed the way the viewer runs it: `ResizableFrame` reports
   * the box it started from plus `factor·dx`; the viewer turns that into a
   * layout width and redraws the box at the zoom in effect. Returns how far
   * the redrawn box moved for each pointer step, and the committed width.
   */
  function replay(zoom: Zoom, start: number, factor: 1 | 2, steps: number[]) {
    let drag: FrameDrag | null = null;
    let z = frameZoom(zoom, AVAILABLE, start, drag);
    const startBox = boxSize(start, z);
    const moved: number[] = [];
    let last = startBox;
    for (const dx of steps) {
      last = startBox + factor * dx;
      const next: FrameDrag = dragStep(drag, last, z);
      drag = next;
      z = frameZoom(zoom, AVAILABLE, next.width, next);
      moved.push(boxSize(next.width, z) - startBox);
    }
    const shown = drag === null ? start : drag.width;
    return { moved, committed: dragStep(drag, last, z).width, shown };
  }

  const steps = [5, 10, 20, 40, 80, -20, -60];
  const zooms: Zoom[] = ['fit', 0.5, 0.75, 1];

  for (const zoom of zooms) {
    for (const factor of [2, 1] as const) {
      test(`at ${zoom}, ${factor === 2 ? 'centred' : 'left-aligned'}: the box moves by ${factor}·dx`, () => {
        const { moved } = replay(zoom, 1440, factor, steps);
        moved.forEach((px, i) => {
          expect(Math.abs(px - factor * (steps[i] ?? 0))).toBeLessThanOrEqual(
            1,
          );
        });
      });
    }
  }

  test('in Fit the layout width changes by 2·dx/z, not faster', () => {
    const z = frameZoom('fit', AVAILABLE, 1440, null);
    const { committed } = replay('fit', 1440, 2, [40]);
    expect(Math.abs(committed - (1440 + (2 * 40) / z))).toBeLessThanOrEqual(1);
  });

  test('the committed width is the width the edge shows, drag after drag', () => {
    let width = 1440;
    for (const dx of [37, -51, 23, -9, 64]) {
      const { committed, shown } = replay('fit', width, 2, [dx]);
      expect(committed).toBe(shown);
      width = committed;
    }
  });

  test('without a drag the zoom is the one in effect', () => {
    expect(frameZoom('fit', AVAILABLE, 1440, null)).toBe(0.67);
    expect(frameZoom(0.5, AVAILABLE, 1440, null)).toBe(0.5);
    expect(frameZoom('fit', AVAILABLE, 2400, { width: 2400, zoom: 0.67 })).toBe(
      0.67,
    );
  });
});

describe('anchorAt (D5)', () => {
  const frame = { left: 100, top: 50, width: 720 };

  test('at 50 %, a click at (400, 300) in the mockup is at the box + (200, 150)', () => {
    expect(anchorAt({ clientX: 400, clientY: 300 }, frame, 0.5)).toEqual({
      left: 300,
      top: 200,
    });
  });

  test('at 100 % the click is added as it is', () => {
    expect(anchorAt({ clientX: 10, clientY: 20 }, frame, 1)).toEqual({
      left: 110,
      top: 70,
    });
  });

  test('a helper that sends no position anchors at the top edge', () => {
    expect(anchorAt({}, frame, 0.5)).toEqual({ left: 460, top: 50 });
  });
});

describe('zoomKey (D6)', () => {
  const key = (k: string, mods: object = { ctrlKey: true }) =>
    zoomKey({ key: k, ctrlKey: false, metaKey: false, altKey: false, ...mods });

  test('Ctrl or Cmd with 0 - =', () => {
    expect(key('0')).toBe('fit');
    expect(key('-')).toBe('out');
    expect(key('=')).toBe('in');
    expect(key('+')).toBe('in');
    expect(key('=', { metaKey: true })).toBe('in');
  });

  test('without Ctrl/Cmd, or with another key, it is not ours', () => {
    expect(key('=', {})).toBeNull();
    expect(key('a')).toBeNull();
    expect(key('=', { ctrlKey: true, altKey: true })).toBeNull();
  });
});

import { describe, expect, test } from 'bun:test';
import { ZOOM_MAX, ZOOM_MIN } from '../design/zoom';
import {
  CANVAS_LABEL_PX,
  centredPan,
  fitAll,
  fitView,
  frameAt,
  layoutRow,
  pinchOf,
  pinchView,
  pointInFrame,
  toWorld,
  wheelStep,
  zoomAround,
} from './geometry';

const devices = [
  { id: 'desktop', width: 1440, height: 900 },
  { id: 'tablet', width: 834, height: 1112 },
  { id: 'phone', width: 390, height: 844 },
];
const row = layoutRow(devices);

describe('layoutRow', () => {
  test('lays the frames side by side at their own sizes, a gap apart', () => {
    expect(row.boxes.map((box) => [box.left, box.top])).toEqual([
      [0, 0],
      [1520, 0],
      [2434, 0],
    ]);
    expect(row.boxes[1]).toMatchObject({ width: 834, height: 1112 });
    expect(row.size).toEqual({ width: 2824, height: 1112 });
  });

  test('takes its own gap; an empty row has no size', () => {
    expect(layoutRow(devices, 20).size.width).toBe(2704);
    expect(layoutRow([]).size).toEqual({ width: 0, height: 0 });
  });
});

describe('fitAll', () => {
  test('the tighter of width and height, rounded down to whole percents', () => {
    // Width: (1200 − 64) / 2824 = 0.402; height: (700 − 64 − 28) / 1112 = 0.547.
    expect(fitAll({ width: 1200, height: 700 }, row.size)).toBe(0.4);
    // Height-bound: (2000 − 64 − 28) / 1112 is wider than the stage allows.
    expect(fitAll({ width: 6000, height: 600 }, row.size)).toBe(0.45);
  });

  test('never above 100 % and never below the minimum zoom', () => {
    expect(fitAll({ width: 9000, height: 3000 }, row.size)).toBe(1);
    expect(fitAll({ width: 400, height: 400 }, row.size)).toBe(ZOOM_MIN);
  });

  test('an unmeasured stage or an empty row draws at 100 %', () => {
    expect(fitAll({ width: 0, height: 0 }, row.size)).toBe(1);
    expect(fitAll({ width: 800, height: 600 }, { width: 0, height: 0 })).toBe(1);
  });

  test('Fit all centres the row and its label band in the stage', () => {
    const stage = { width: 1200, height: 700 };
    const view = fitView(stage, row.size);
    expect(view.scale).toBe(0.4);
    expect(view.pan.x + (row.size.width * view.scale) / 2).toBeCloseTo(600);
    const top = view.pan.y - CANVAS_LABEL_PX;
    const bottom = view.pan.y + row.size.height * view.scale;
    expect(top).toBeCloseTo(stage.height - bottom);
    expect(centredPan(stage, row.size, 0.4)).toEqual(view.pan);
  });
});

describe('zoomAround', () => {
  test('keeps the anchor over the same world point', () => {
    const view = { scale: 1, pan: { x: 0, y: 0 } };
    const anchor = { x: 100, y: 100 };
    const next = zoomAround(view, 2, anchor);
    expect(next).toEqual({ scale: 2, pan: { x: -100, y: -100 } });
    expect(toWorld(next, anchor)).toEqual(toWorld(view, anchor));
  });

  test('clamps to the zoom range, on whole percents', () => {
    const view = { scale: 1, pan: { x: 40, y: 40 } };
    expect(zoomAround(view, 10, { x: 0, y: 0 }).scale).toBe(ZOOM_MAX);
    expect(zoomAround(view, 0.01, { x: 0, y: 0 }).scale).toBe(ZOOM_MIN);
    expect(zoomAround(view, 0.3333, { x: 0, y: 0 }).scale).toBe(0.33);
  });
});

describe('wheelStep', () => {
  test('a trackpad pinch adds up its small deltas until the zoom moves', () => {
    let state = { scale: 1, pending: 0 };
    let events = 0;
    while (state.scale === 1 && events < 20) {
      state = wheelStep(state.scale, state.pending, 1);
      events += 1;
    }
    expect(state.scale).toBe(0.99);
    expect(state.pending).toBe(0);
    expect(events).toBeGreaterThan(1);
  });

  test('a mouse wheel notch moves it at once, inside the range', () => {
    expect(wheelStep(1, 0, -100).scale).toBeGreaterThan(1);
    expect(wheelStep(ZOOM_MAX, 0, -100)).toEqual({ scale: ZOOM_MAX, pending: -100 });
  });
});

describe('pinchView', () => {
  test('scales by the spread and follows the centre', () => {
    const start = {
      view: { scale: 1, pan: { x: 0, y: 0 } },
      ...pinchOf({ x: 50, y: 100 }, { x: 150, y: 100 }),
    };
    const now = pinchOf({ x: 10, y: 100 }, { x: 210, y: 100 });
    const next = pinchView(start, now.centre, now.distance);
    expect(next.scale).toBe(2);
    // The world point first under the centre is under the moved centre.
    expect(toWorld(next, { x: 110, y: 100 })).toEqual({ x: 100, y: 100 });
  });

  test('two pointers on one spot change nothing', () => {
    const view = { scale: 0.5, pan: { x: 3, y: 4 } };
    const start = { view, centre: { x: 0, y: 0 }, distance: 0 };
    expect(pinchView(start, { x: 9, y: 9 }, 50)).toBe(view);
  });
});

describe('pointInFrame', () => {
  const view = { scale: 0.5, pan: { x: 10, y: 20 } };
  const stage = { left: 100, top: 50 };
  const tablet = row.boxes[1];
  if (!tablet) throw new Error('tablet box expected');

  test("maps a pointer into the frame's own px at the current scale", () => {
    const pointer = {
      clientX: 100 + 10 + (1520 + 30) * 0.5,
      clientY: 50 + 20 + 40 * 0.5,
    };
    expect(pointInFrame(pointer, stage, view, tablet)).toEqual({ x: 30, y: 40 });
  });

  test('the same screen spot is a different frame point at another scale', () => {
    const pointer = { clientX: 885, clientY: 90 };
    const zoomed = { scale: 1, pan: { x: -1000, y: 20 } };
    expect(pointInFrame(pointer, stage, zoomed, tablet)).toEqual({
      x: 265,
      y: 20,
    });
  });

  test('null outside the frame; frameAt finds which frame is hit', () => {
    expect(
      pointInFrame({ clientX: 110, clientY: 70 }, stage, view, tablet),
    ).toBeNull();
    expect(frameAt(row.boxes, { x: 2500, y: 10 })?.id).toBe('phone');
    expect(frameAt(row.boxes, { x: 1480, y: 10 })).toBeNull();
    expect(frameAt(row.boxes, { x: 2500, y: 900 })).toBeNull();
  });
});

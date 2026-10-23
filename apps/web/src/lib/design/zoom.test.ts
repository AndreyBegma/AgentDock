import { describe, expect, test } from 'bun:test';
import {
  anchorAt,
  clampZoom,
  fitZoom,
  stepZoom,
  wheelZoom,
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

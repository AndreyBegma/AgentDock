import { describe, expect, test } from 'bun:test';
import { DEFAULT_VIEWPORTS } from '@nautelle/shared';
import { design, framesOf, revision } from './fixtures';
import {
  applyViewerChange,
  devicesOf,
  frameOf,
  parsePan,
  parseZoom,
  resolveViewerState,
  revisionsOf,
  variantsOf,
} from './viewer-state';

const { revisions, viewports } = design();
const resolve = (query: string) =>
  resolveViewerState(new URLSearchParams(query), revisions, viewports);

describe('resolveViewerState', () => {
  test('defaults: the latest revision of the first variant, the first device in light', () => {
    const state = resolve('');
    expect(state.variant).toBe(1);
    expect(state.revision?.id).toBe('rev-1-2');
    expect(state.devices).toEqual(viewports);
    expect(state.device.name).toBe('Desktop');
    expect(state.theme).toBe('light');
    expect(state.zoom).toBe('fit');
    expect(state.pan).toEqual({ x: 0, y: 0 });
  });

  test('a named revision fixes its variant', () => {
    const state = resolve('variant=1&rev=rev-2-1');
    expect(state.variant).toBe(2);
    expect(state.revision?.id).toBe('rev-2-1');
  });

  test('an unknown variant, device or theme falls back', () => {
    const state = resolve('variant=7&device=Watch&theme=sepia');
    expect(state.variant).toBe(1);
    expect(state.device.name).toBe('Desktop');
    expect(state.theme).toBe('light');
  });

  test('a named device is the one in view', () => {
    expect(resolve('device=Phone').device.name).toBe('Phone');
  });

  test("#886: the single-frame viewer's preset and width are ignored", () => {
    const state = resolve('vp=Phone&w=412');
    expect(state.device.name).toBe('Desktop');
    expect(state.devices).toEqual(viewports);
  });

  test("the first device's own theme is the default", () => {
    const state = resolveViewerState(new URLSearchParams(''), revisions, [
      { name: 'Night', width: 800, height: 600, theme: 'dark' },
    ]);
    expect(state.theme).toBe('dark');
  });

  test('no devices: the built-in ones', () => {
    const state = resolveViewerState(new URLSearchParams(''), revisions, []);
    expect(state.devices).toEqual(DEFAULT_VIEWPORTS);
    expect(state.device).toEqual(DEFAULT_VIEWPORTS[0]);
  });

  test('a design without revisions has none in view', () => {
    const state = resolveViewerState(new URLSearchParams(''), [], viewports);
    expect(state.revision).toBeNull();
    expect(state.variant).toBe(1);
  });
});

describe('devicesOf (#886)', () => {
  const presets = [{ name: 'Wide', width: 1920, height: 1080 }];
  const stored = [{ name: 'Kiosk', width: 1080, height: 1920 }];

  test('the devices stored on the design win', () => {
    expect(devicesOf({ devices: stored, viewports: presets })).toBe(stored);
  });

  test("a design with no stored devices uses the project's presets", () => {
    expect(devicesOf({ devices: null, viewports: presets })).toBe(presets);
    expect(devicesOf({ devices: [], viewports: presets })).toBe(presets);
  });

  test('nothing at all: the built-in devices', () => {
    expect(devicesOf({ devices: null, viewports: [] })).toBe(DEFAULT_VIEWPORTS);
  });

  test('an earlier revision with a mobile frame opens as one more tab', () => {
    const legacy = revision({
      id: 'old',
      frames: framesOf('old', ['Mockup', 'Mobile']),
    });
    const state = resolveViewerState(
      new URLSearchParams('frame=1'),
      [legacy],
      devicesOf({ devices: null, viewports: presets }),
    );
    expect(state.frame).toBe(1);
    expect(frameOf(state)?.name).toBe('Mobile');
    expect(state.devices).toEqual(presets);
  });
});

describe('frames (#441)', () => {
  const framed = [
    revision({
      id: 'f',
      frames: framesOf('f', ['Board page', 'Card page', 'Frame tabs']),
    }),
  ];
  const at = (query: string) =>
    resolveViewerState(new URLSearchParams(query), framed, viewports);

  test('the first frame by default, the named one from ?frame=', () => {
    expect(at('').frame).toBe(0);
    expect(frameOf(at(''))?.name).toBe('Board page');
    expect(at('frame=2').frame).toBe(2);
    expect(frameOf(at('frame=2'))?.name).toBe('Frame tabs');
  });

  test('a frame past the end or not a number is the first', () => {
    expect(at('frame=3').frame).toBe(0);
    expect(at('frame=-1').frame).toBe(0);
    expect(at('frame=x').frame).toBe(0);
    // A legacy revision has one frame.
    expect(resolve('frame=1').frame).toBe(0);
    expect(frameOf(resolve(''))?.name).toBe('Mockup');
  });

  test('the first frame leaves the URL, any other is kept beside the rest', () => {
    const params = new URLSearchParams('variant=1&frame=2');
    expect(applyViewerChange(params, { kind: 'frame', frame: 0 })).toBe(
      '?variant=1',
    );
    expect(applyViewerChange(params, { kind: 'frame', frame: 1 })).toBe(
      '?variant=1&frame=1',
    );
    expect(applyViewerChange(params, { kind: 'variant', variant: 2 })).toBe(
      '?variant=2&frame=2',
    );
  });
});

describe('variants and revisions', () => {
  test('archived variants drop out once another is approved', () => {
    const list = [
      revision({ id: 'a', variant: 1 }),
      revision({ id: 'b', variant: 2, archived: true }),
      revision({ id: 'c', variant: 3, archived: true }),
    ];
    expect(variantsOf(list)).toEqual([1]);
    expect(variantsOf(revisions)).toEqual([1, 2]);
  });

  test('every revision archived still shows them', () => {
    expect(variantsOf([revision({ archived: true })])).toEqual([1]);
  });

  test('revisions of a variant come newest first', () => {
    expect(revisionsOf(revisions, 1).map((r) => r.revision)).toEqual([2, 1]);
  });
});

describe('applyViewerChange', () => {
  const params = new URLSearchParams('variant=1&rev=rev-1-1');

  test('a variant drops the revision', () => {
    expect(applyViewerChange(params, { kind: 'variant', variant: 2 })).toBe(
      '?variant=2',
    );
  });

  test('a device and a theme are kept beside the rest', () => {
    expect(applyViewerChange(params, { kind: 'device', device: 'Phone' })).toBe(
      '?variant=1&rev=rev-1-1&device=Phone',
    );
    expect(applyViewerChange(params, { kind: 'theme', theme: 'dark' })).toBe(
      '?variant=1&rev=rev-1-1&theme=dark',
    );
  });

  test('#886: any change drops the legacy vp and w', () => {
    const legacy = new URLSearchParams('vp=Mobile&w=500&frame=1');
    expect(applyViewerChange(legacy, { kind: 'theme', theme: 'dark' })).toBe(
      '?frame=1&theme=dark',
    );
  });

  test('a view keeps its zoom and pan, and Fit all leaves the URL', () => {
    expect(
      applyViewerChange(params, {
        kind: 'view',
        zoom: 0.5,
        pan: { x: 120.4, y: -40.6 },
      }),
    ).toBe('?variant=1&rev=rev-1-1&zoom=0.5&pan=120%2C-41');
    const zoomed = new URLSearchParams('frame=1&zoom=0.5&pan=1,2');
    expect(
      applyViewerChange(zoomed, {
        kind: 'view',
        zoom: 'fit',
        pan: { x: 1, y: 2 },
      }),
    ).toBe('?frame=1');
  });

  test('a zoom is clamped on the way out', () => {
    expect(
      applyViewerChange(new URLSearchParams(), {
        kind: 'view',
        zoom: 9,
        pan: { x: 0, y: 0 },
      }),
    ).toBe('?zoom=2&pan=0%2C0');
  });

  test("a comment's place names its revision, tab, device and theme", () => {
    expect(
      applyViewerChange(new URLSearchParams('variant=2&frame=1'), {
        kind: 'place',
        revisionId: 'rev-1-1',
        frame: 2,
        device: 'Tablet',
        theme: 'dark',
      }),
    ).toBe('?frame=2&rev=rev-1-1&device=Tablet&theme=dark');
  });

  test('a place without a device or theme keeps the ones in view', () => {
    expect(
      applyViewerChange(new URLSearchParams('device=Phone&theme=dark'), {
        kind: 'place',
        revisionId: 'rev-1-1',
        frame: 0,
        device: null,
        theme: null,
      }),
    ).toBe('?device=Phone&theme=dark&rev=rev-1-1');
  });
});

describe('zoom and pan in the URL', () => {
  test('defaults to Fit all at the origin', () => {
    expect(resolve('').zoom).toBe('fit');
    expect(resolve('pan=10,10').pan).toEqual({ x: 0, y: 0 });
  });

  test('fit and a number parse', () => {
    expect(resolve('zoom=fit').zoom).toBe('fit');
    expect(resolve('zoom=0.75').zoom).toBe(0.75);
    expect(resolve('zoom=1').zoom).toBe(1);
  });

  test('out of range is clamped', () => {
    expect(resolve('zoom=0.01').zoom).toBe(0.25);
    expect(resolve('zoom=9').zoom).toBe(2);
  });

  test('garbage is Fit', () => {
    for (const raw of ['abc', '', '-1', '0', '1e3', '0.5x', 'NaN', '.']) {
      expect(resolve(`zoom=${raw}`).zoom).toBe('fit');
    }
  });

  test('a number past eight characters is Fit', () => {
    expect(parseZoom('1.234567')).toBe(1.23);
    expect(parseZoom('1.2345678')).toBe('fit');
    expect(parseZoom('00000001')).toBe(1);
    expect(parseZoom('1.')).toBe('fit');
  });

  // WI-61: `/^\d*\.?\d+$/` was quadratic on a long run of digits.
  test('turns down 100 KB of digits in under 50 ms', () => {
    const started = performance.now();
    expect(parseZoom(`${'1'.repeat(100_000)}x`)).toBe('fit');
    expect(performance.now() - started).toBeLessThan(50);
  });

  test('a pan is two whole numbers, negatives allowed', () => {
    expect(parsePan('120,-40')).toEqual({ x: 120, y: -40 });
    expect(parsePan('-0,0')).toEqual({ x: -0, y: 0 });
  });

  test('a garbled or far-off pan is the origin', () => {
    for (const raw of ['', '1', '1,2,3', '1.5,2', 'a,b', '200000,0', '1, 2']) {
      expect(parsePan(raw)).toEqual({ x: 0, y: 0 });
    }
    expect(parsePan(`${'1'.repeat(100_000)},1`)).toEqual({ x: 0, y: 0 });
  });

  test('a view round-trips through the URL', () => {
    for (const zoom of [0.25, 0.4, 0.5, 0.75, 1, 1.25, 2] as const) {
      const query = applyViewerChange(new URLSearchParams('frame=1'), {
        kind: 'view',
        zoom,
        pan: { x: -320, y: 48 },
      });
      const state = resolve(query.slice(1));
      expect(state.zoom).toBe(zoom);
      expect(state.pan).toEqual({ x: -320, y: 48 });
    }
  });
});

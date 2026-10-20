import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_VIEWPORTS,
  DESIGN_VIEWPORT_MAX_PX,
  DESIGN_VIEWPORT_MIN_PX,
} from '@nautelle/shared';
import { design, framesOf, revision } from './fixtures';
import {
  applyViewerChange,
  clampWidth,
  frameOf,
  resolveViewerState,
  revisionsOf,
  variantsOf,
} from './viewer-state';

const { revisions, viewports } = design();
const resolve = (query: string) =>
  resolveViewerState(new URLSearchParams(query), revisions, viewports);

describe('resolveViewerState', () => {
  test('defaults: the latest revision of the first variant, the first preset in light', () => {
    const state = resolve('');
    expect(state.variant).toBe(1);
    expect(state.revision?.id).toBe('rev-1-2');
    expect(state.viewport.name).toBe('Desktop');
    expect(state.theme).toBe('light');
    expect(state.width).toBe(1440);
    expect(state.customWidth).toBe(false);
  });

  test('a named revision fixes its variant', () => {
    const state = resolve('variant=1&rev=rev-2-1');
    expect(state.variant).toBe(2);
    expect(state.revision?.id).toBe('rev-2-1');
  });

  test('an unknown variant, preset, theme or width falls back', () => {
    const state = resolve('variant=7&vp=Watch&theme=sepia&w=abc');
    expect(state.variant).toBe(1);
    expect(state.viewport.name).toBe('Desktop');
    expect(state.theme).toBe('light');
    expect(state.width).toBe(1440);
  });

  test('a typed width is clamped and marked custom', () => {
    expect(resolve('w=10').width).toBe(DESIGN_VIEWPORT_MIN_PX);
    expect(resolve('w=99999').width).toBe(DESIGN_VIEWPORT_MAX_PX);
    expect(resolve('vp=Mobile&w=412').customWidth).toBe(true);
  });

  test("a preset's own theme is its default", () => {
    const state = resolveViewerState(
      new URLSearchParams('vp=Night'),
      revisions,
      [{ name: 'Night', width: 800, height: 600, theme: 'dark' }],
    );
    expect(state.theme).toBe('dark');
  });

  test('no presets: the defaults', () => {
    const state = resolveViewerState(new URLSearchParams(''), revisions, []);
    expect(state.viewport).toEqual(DEFAULT_VIEWPORTS[0]);
  });

  test('a design without revisions has none in view', () => {
    const state = resolveViewerState(new URLSearchParams(''), [], viewports);
    expect(state.revision).toBeNull();
    expect(state.variant).toBe(1);
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
  const params = new URLSearchParams('variant=1&rev=rev-1-1&vp=Mobile&w=500');

  test('a variant drops the revision', () => {
    expect(applyViewerChange(params, { kind: 'variant', variant: 2 })).toBe(
      '?variant=2&vp=Mobile&w=500',
    );
  });

  test('a preset drops the typed width and takes its theme', () => {
    expect(
      applyViewerChange(params, {
        kind: 'viewport',
        viewport: { name: 'Night', width: 1, height: 1, theme: 'dark' },
      }),
    ).toBe('?variant=1&rev=rev-1-1&vp=Night&theme=dark');
  });

  test('a preset with fit goes back to Fit, as on a phone', () => {
    const zoomed = new URLSearchParams('vp=Desktop&zoom=2');
    expect(
      applyViewerChange(zoomed, {
        kind: 'viewport',
        viewport: { name: 'Mobile', width: 390, height: 844 },
        fit: true,
      }),
    ).toBe('?vp=Mobile');
  });

  test('a width is clamped', () => {
    const empty = new URLSearchParams();
    expect(applyViewerChange(empty, { kind: 'width', width: 1 })).toBe(
      `?w=${DESIGN_VIEWPORT_MIN_PX}`,
    );
    expect(clampWidth(412.6)).toBe(413);
  });

  test('a zoom is kept next to the rest, and Fit leaves the URL', () => {
    expect(applyViewerChange(params, { kind: 'zoom', zoom: 0.5 })).toBe(
      '?variant=1&rev=rev-1-1&vp=Mobile&w=500&zoom=0.5',
    );
    const zoomed = new URLSearchParams('vp=Mobile&zoom=0.5');
    expect(applyViewerChange(zoomed, { kind: 'zoom', zoom: 'fit' })).toBe(
      '?vp=Mobile',
    );
  });

  test('a zoom is clamped on the way out', () => {
    const empty = new URLSearchParams();
    expect(applyViewerChange(empty, { kind: 'zoom', zoom: 9 })).toBe('?zoom=2');
  });

  test('choosing a preset keeps the zoom', () => {
    const next = applyViewerChange(new URLSearchParams('zoom=0.75'), {
      kind: 'viewport',
      viewport: { name: 'Mobile', width: 390, height: 844 },
    });
    expect(next).toBe('?zoom=0.75&vp=Mobile');
  });
});

describe('zoom in the URL', () => {
  test('defaults to Fit', () => {
    expect(resolve('').zoom).toBe('fit');
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

  test('round-trips through the URL', () => {
    for (const zoom of [0.25, 0.4, 0.5, 0.75, 1, 1.25, 2] as const) {
      const query = applyViewerChange(new URLSearchParams(), {
        kind: 'zoom',
        zoom,
      });
      expect(resolve(query.slice(1)).zoom).toBe(zoom);
    }
    const fit = applyViewerChange(new URLSearchParams('zoom=0.5'), {
      kind: 'zoom',
      zoom: 'fit',
    });
    expect(resolve(fit.slice(1)).zoom).toBe('fit');
  });
});

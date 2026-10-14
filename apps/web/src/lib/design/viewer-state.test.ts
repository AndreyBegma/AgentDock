import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_VIEWPORTS,
  DESIGN_VIEWPORT_MAX_PX,
  DESIGN_VIEWPORT_MIN_PX,
} from '@agentdock/shared';
import { design, revision } from './fixtures';
import {
  applyViewerChange,
  clampWidth,
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

  test('a width is clamped', () => {
    const empty = new URLSearchParams();
    expect(applyViewerChange(empty, { kind: 'width', width: 1 })).toBe(
      `?w=${DESIGN_VIEWPORT_MIN_PX}`,
    );
    expect(clampWidth(412.6)).toBe(413);
  });
});

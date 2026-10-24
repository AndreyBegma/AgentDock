import { describe, expect, it } from 'bun:test';
import { productUpdateView } from './product-update';

const release = (version: string) => ({
  version,
  url: `https://github.com/AndreyBegma/Nautelle/releases/tag/v${version}`,
});

describe('productUpdateView (C-374)', () => {
  it('offers a newer release', () => {
    const view = productUpdateView(
      '0.15.0',
      release('0.16.0'),
      true,
      '2026-10-24T10:00:00.000Z',
    );
    expect(view).toEqual({
      current: '0.15.0',
      latest: release('0.16.0'),
      available: true,
      checkEnabled: true,
      checkedAt: '2026-10-24T10:00:00.000Z',
    });
  });

  it('offers nothing for the same or an older release', () => {
    expect(
      productUpdateView('0.16.0', release('0.16.0'), true, null).available,
    ).toBe(false);
    expect(
      productUpdateView('0.16.1', release('0.16.0'), true, null).available,
    ).toBe(false);
  });

  it('compares numerically', () => {
    expect(
      productUpdateView('0.9.0', release('0.10.0'), true, null).available,
    ).toBe(true);
  });

  it('offers nothing without a release or with a version that is not semver', () => {
    expect(productUpdateView('0.15.0', null, false, null).available).toBe(
      false,
    );
    expect(
      productUpdateView('dev', release('0.16.0'), true, null).available,
    ).toBe(false);
  });
});

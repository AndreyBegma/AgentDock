import { describe, expect, test } from 'bun:test';
import type { ProductUpdateView } from '@nautelle/shared';
import {
  DISMISSED_PRODUCT_RELEASE_KEY,
  productUpdateNotice,
  productUpdateTitle,
  readDismissedProductRelease,
  storeDismissedProductRelease,
} from './product-update';

const latest = {
  version: '0.16.0',
  url: 'https://github.com/AndreyBegma/Nautelle/releases/tag/v0.16.0',
};

const view = (
  overrides: Partial<ProductUpdateView> = {},
): ProductUpdateView => ({
  current: '0.15.0',
  latest,
  available: true,
  checkEnabled: true,
  checkedAt: '2026-10-24T10:00:00.000Z',
  ...overrides,
});

describe('productUpdateNotice (C-374)', () => {
  test('shows the newer release', () => {
    expect(productUpdateNotice(view(), null)).toEqual(latest);
    expect(productUpdateTitle(latest)).toBe('Nautelle 0.16.0 is available');
  });

  test('shows nothing when the install is on the release or the check is off', () => {
    expect(productUpdateNotice(view({ available: false }), null)).toBeNull();
    expect(
      productUpdateNotice(
        view({ latest: null, available: false, checkEnabled: false }),
        null,
      ),
    ).toBeNull();
    expect(productUpdateNotice(null, null)).toBeNull();
  });

  test('a dismissal lasts until the next release', () => {
    expect(productUpdateNotice(view(), '0.16.0')).toBeNull();
    expect(productUpdateNotice(view(), '0.15.1')).toEqual(latest);
  });
});

describe('dismissed product release (C-374)', () => {
  const memory = () => {
    const items = new Map<string, string>();
    return {
      items,
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => {
        items.set(key, value);
      },
    };
  };

  test('round-trips through storage', () => {
    const storage = memory();
    expect(readDismissedProductRelease(storage)).toBeNull();
    storeDismissedProductRelease('0.16.0', storage);
    expect(storage.items.get(DISMISSED_PRODUCT_RELEASE_KEY)).toBe('0.16.0');
    expect(readDismissedProductRelease(storage)).toBe('0.16.0');
  });

  test('survives blocked or missing storage', () => {
    const blocked = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('SecurityError');
      },
    };
    expect(readDismissedProductRelease(blocked)).toBeNull();
    expect(() => storeDismissedProductRelease('0.16.0', blocked)).not.toThrow();
    expect(readDismissedProductRelease(null)).toBeNull();
  });
});

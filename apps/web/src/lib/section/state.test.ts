import { describe, expect, test } from 'bun:test';
import { sectionView } from './state';

describe('sectionView', () => {
  test('nothing loaded yet is loading', () => {
    expect(sectionView({ data: undefined, error: null, loading: true })).toBe(
      'loading',
    );
  });

  test('a failure with no data is unavailable, never empty', () => {
    expect(
      sectionView({ data: undefined, error: new Error('x'), loading: false }),
    ).toBe('unavailable');
  });

  test('a retry in flight after a failure shows loading', () => {
    expect(
      sectionView({ data: undefined, error: new Error('x'), loading: true }),
    ).toBe('loading');
  });

  test('a failure keeps the data it already had', () => {
    expect(
      sectionView({ data: [1, 2], error: new Error('x'), loading: false }),
    ).toBe('ready');
  });

  test('an empty list is empty; a refresh keeps it on screen', () => {
    expect(sectionView({ data: [], error: null, loading: false })).toBe(
      'empty',
    );
    expect(sectionView({ data: [], error: null, loading: true })).toBe('empty');
  });

  test('a caller decides what empty means for its shape', () => {
    const page = { items: [] as number[], total: 0 };
    expect(
      sectionView(
        { data: page, error: null, loading: false },
        (value) => value.total === 0,
      ),
    ).toBe('empty');
    expect(sectionView({ data: page, error: null, loading: false })).toBe(
      'ready',
    );
  });
});

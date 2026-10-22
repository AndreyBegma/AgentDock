import { describe, expect, it } from 'bun:test';
import { designFrameSlug, designFrameSlugs } from './frames';

describe('designFrameSlug', () => {
  it('makes a file name stem of a frame name', () => {
    expect(designFrameSlug('Board page')).toBe('board-page');
    expect(designFrameSlug('Café — tile')).toBe('cafe-tile');
    expect(designFrameSlug('***')).toBe('frame');
  });
});

describe('designFrameSlugs', () => {
  it('keeps the slugs distinct, in order', () => {
    expect(designFrameSlugs(['Page', 'page', 'Page 2', 'PAGE'])).toEqual([
      'page',
      'page-2',
      'page-2-2',
      'page-3',
    ]);
  });

  it('skips a suffix another frame already took', () => {
    expect(designFrameSlugs(['Page', 'Page-2', 'Page', 'Page'])).toEqual([
      'page',
      'page-2',
      'page-3',
      'page-4',
    ]);
  });

  it('DA-17: slugs 50k frames of one name in linear time', () => {
    const names = Array.from({ length: 50_000 }, () => 'Page');
    const started = performance.now();
    const slugs = designFrameSlugs(names);
    expect(performance.now() - started).toBeLessThan(500);
    expect(new Set(slugs).size).toBe(names.length);
    expect(slugs.at(-1)).toBe('page-50000');
  });
});

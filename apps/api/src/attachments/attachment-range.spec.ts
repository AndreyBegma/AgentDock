import { parseByteRange, UNSATISFIABLE } from './attachment-range';

describe('parseByteRange (ADR-0090)', () => {
  it('reads a closed, an open and a suffix range', () => {
    expect(parseByteRange('bytes=0-99', 1000)).toEqual({ start: 0, end: 99 });
    expect(parseByteRange('bytes=900-', 1000)).toEqual({
      start: 900,
      end: 999,
    });
    expect(parseByteRange('bytes=-100', 1000)).toEqual({
      start: 900,
      end: 999,
    });
  });

  it('clamps an end and a suffix past the file', () => {
    expect(parseByteRange('bytes=10-5000', 1000)).toEqual({
      start: 10,
      end: 999,
    });
    expect(parseByteRange('bytes=-5000', 1000)).toEqual({
      start: 0,
      end: 999,
    });
  });

  it('serves the whole file for no header, another unit, several ranges or garbage', () => {
    expect(parseByteRange(undefined, 1000)).toBeNull();
    expect(parseByteRange('items=0-1', 1000)).toBeNull();
    expect(parseByteRange('bytes=0-1,5-9', 1000)).toBeNull();
    expect(parseByteRange('bytes=-', 1000)).toBeNull();
    expect(parseByteRange('bytes=9-1', 1000)).toBeNull();
    expect(parseByteRange('bytes=a-b', 1000)).toBeNull();
  });

  it('is unsatisfiable past the end or for an empty suffix', () => {
    expect(parseByteRange('bytes=1000-', 1000)).toBe(UNSATISFIABLE);
    expect(parseByteRange('bytes=-0', 1000)).toBe(UNSATISFIABLE);
    expect(parseByteRange('bytes=0-', 0)).toBe(UNSATISFIABLE);
  });
});

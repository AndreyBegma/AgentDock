import { describe, expect, test } from 'bun:test';
import { DEFAULT_VIEWPORTS, DESIGN_VIEWPORTS_MAX } from '@nautelle/shared';
import {
  blankRow,
  canAddRow,
  moveRow,
  readViewportRows,
  toRows,
} from './viewports';

describe('readViewportRows', () => {
  test('round-trips the defaults', () => {
    expect(readViewportRows(toRows(DEFAULT_VIEWPORTS))).toEqual({
      ok: true,
      presets: [...DEFAULT_VIEWPORTS],
    });
  });

  test('keeps a theme, trims a name', () => {
    const [row] = toRows([{ name: 'Night', width: 800, height: 600 }]);
    const result = readViewportRows([
      { ...row, name: ' Night ', theme: 'dark' },
    ]);
    expect(result).toEqual({
      ok: true,
      presets: [{ name: 'Night', width: 800, height: 600, theme: 'dark' }],
    });
  });

  test('names each bad row', () => {
    const rows = toRows(DEFAULT_VIEWPORTS);
    const bad = [
      { ...rows[0], width: '12.5' },
      { ...rows[1], name: ' ' },
      { ...blankRow(), name: 'Desktop' },
      { ...blankRow(), name: 'Tall', height: '99999' },
    ];
    const result = readViewportRows(bad);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[bad[0].key]).toMatch(/Width/);
    expect(result.errors[bad[1].key]).toMatch(/name/);
    expect(result.errors[bad[3].key]).toMatch(/Height/);
    expect(result.listError).toBeNull();
  });

  test('duplicate names: the second is wrong', () => {
    const rows = [
      ...toRows(DEFAULT_VIEWPORTS),
      { ...blankRow(), name: 'Phone' },
    ];
    const result = readViewportRows(rows);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(Object.keys(result.errors)).toEqual([rows[3].key]);
  });

  test('an empty list is refused', () => {
    expect(readViewportRows([])).toEqual({
      ok: false,
      errors: {},
      listError: 'Keep at least one preset.',
    });
  });
});

describe('row editing', () => {
  test('moves within bounds', () => {
    const rows = toRows(DEFAULT_VIEWPORTS);
    const names = (delta: number) => moveRow(rows, 0, delta).map((r) => r.name);
    expect(names(1)).toEqual(['Tablet', 'Desktop', 'Phone']);
    expect(names(-1)).toEqual(['Desktop', 'Tablet', 'Phone']);
  });

  test('stops adding at the limit', () => {
    const full = Array.from({ length: DESIGN_VIEWPORTS_MAX }, blankRow);
    expect(canAddRow(full)).toBe(false);
    expect(canAddRow(full.slice(1))).toBe(true);
  });

  test('keys are unique', () => {
    const keys = [...toRows(DEFAULT_VIEWPORTS), blankRow()].map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

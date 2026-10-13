import { describe, expect, test } from 'bun:test';
import { HUES } from '@andrewbehma/glass-ui/hue';
import { projectHue, slotHue } from './hue';

describe('projectHue / slotHue', () => {
  test('the same key always gets the same hue', () => {
    expect(projectHue('p1')).toBe(projectHue('p1'));
    expect(slotHue('i163')).toBe(slotHue('i163'));
  });

  test('every key lands on one of the eight hues', () => {
    for (const key of ['p1', 'cm9x0abc', 'i163', 'i172-contract', '']) {
      expect(HUES).toContain(projectHue(key));
      expect(HUES).toContain(slotHue(key));
    }
  });

  test('neighbouring slot names spread across hues', () => {
    const hues = new Set(
      ['i1', 'i2', 'i3', 'i4', 'i5', 'i6', 'i7', 'i8'].map(slotHue),
    );
    expect(hues.size).toBeGreaterThan(3);
  });
});

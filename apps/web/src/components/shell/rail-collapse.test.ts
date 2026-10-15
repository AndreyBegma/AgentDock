import { describe, expect, test } from 'bun:test';
import { isRailToggleShortcut, railToggleLabel } from './rail-collapse';

const key = (
  overrides: Partial<Parameters<typeof isRailToggleShortcut>[0]>,
) => ({
  key: '\\',
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...overrides,
});

describe('isRailToggleShortcut', () => {
  test('⌘\\ and Ctrl+\\ toggle the rail', () => {
    expect(isRailToggleShortcut(key({ metaKey: true }))).toBe(true);
    expect(isRailToggleShortcut(key({ ctrlKey: true }))).toBe(true);
  });

  test('a bare backslash is typing, not a shortcut', () => {
    expect(isRailToggleShortcut(key({}))).toBe(false);
  });

  test('another key or an extra modifier is not the shortcut', () => {
    expect(isRailToggleShortcut(key({ key: 'b', metaKey: true }))).toBe(false);
    expect(isRailToggleShortcut(key({ metaKey: true, shiftKey: true }))).toBe(
      false,
    );
    expect(isRailToggleShortcut(key({ ctrlKey: true, altKey: true }))).toBe(
      false,
    );
  });
});

describe('railToggleLabel', () => {
  test('names what pressing the toggle does', () => {
    expect(railToggleLabel(false)).toBe('Collapse sidebar');
    expect(railToggleLabel(true)).toBe('Expand sidebar');
  });
});

import { describe, expect, it } from 'bun:test';
import {
  APP_VERSION,
  CHANGE_KINDS,
  CHANGELOG,
  whatsNewView,
} from './changelog';

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

const parts = (version: string) => version.split('.').map(Number);

const isNewer = (a: string, b: string) => {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  }
  return false;
};

describe('CHANGELOG (C-294)', () => {
  it('starts at 0.14.0, and APP_VERSION is the newest entry', () => {
    expect(CHANGELOG.at(-1)?.version).toBe('0.14.0');
    expect(APP_VERSION).toBe(CHANGELOG[0]?.version ?? '');
  });

  it('is newest first, by version and by date, with no version twice', () => {
    for (let i = 1; i < CHANGELOG.length; i++) {
      const [newer, older] = [CHANGELOG[i - 1], CHANGELOG[i]];
      if (!newer || !older) throw new Error('entry expected');
      expect(isNewer(newer.version, older.version)).toBe(true);
      expect(newer.date >= older.date).toBe(true);
    }
  });

  it('holds 3 to 8 one-sentence items per entry, new then improved then fixed', () => {
    for (const entry of CHANGELOG) {
      expect(entry.version).toMatch(SEMVER);
      expect(entry.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(entry.items.length).toBeGreaterThanOrEqual(3);
      expect(entry.items.length).toBeLessThanOrEqual(8);
      const order = entry.items.map((item) => CHANGE_KINDS.indexOf(item.kind));
      expect(order).toEqual([...order].sort((a, b) => a - b));
      for (const item of entry.items) {
        expect(item.text).toMatch(/^[A-Z].*\.$/);
        expect(item.text).not.toContain(';');
        expect(item.text).not.toMatch(/#\d|C-\d/);
      }
    }
  });
});

describe('whatsNewView', () => {
  it('is unread until the current version was seen', () => {
    expect(whatsNewView(null, '0.15.0')).toEqual({
      version: '0.15.0',
      seenVersion: null,
      unread: true,
    });
    expect(whatsNewView('0.14.0', '0.15.0').unread).toBe(true);
    expect(whatsNewView('0.15.0', '0.15.0').unread).toBe(false);
    expect(whatsNewView(undefined).version).toBe(APP_VERSION);
  });
});

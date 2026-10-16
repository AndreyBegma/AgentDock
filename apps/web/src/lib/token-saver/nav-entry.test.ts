import { describe, expect, test } from 'bun:test';
import {
  activeEntryId,
  isWideEntry,
  visibleNav,
} from '../../components/shell/nav';

const entryAt = (path: string) =>
  visibleNav('viewer', path)
    .flatMap((section) => section.entries)
    .find((e) => e.id === 'project-token-saver');

describe('Token saver nav entry (#445 D13)', () => {
  test('is a project page every member sees, linked to the current project', () => {
    expect(entryAt('/projects/p1/fleet')?.resolvedHref).toBe(
      '/projects/p1/token-saver',
    );
  });

  test('is active on its page and takes the wide column', () => {
    const path = '/projects/p1/token-saver';
    const sections = visibleNav('viewer', path);
    const active = activeEntryId(sections, path);
    expect(active).toBe('project-token-saver');
    expect(isWideEntry(sections, active)).toBe(true);
  });

  test('is absent outside a project', () => {
    expect(entryAt('/')).toBeUndefined();
  });
});

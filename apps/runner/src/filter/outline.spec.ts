import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OUTLINE_MAX, outline, renderOutline } from './outline';

// Expected entries are the plugin's `eco_hook.outline()` on the same input.
const fixture = (name: string): string =>
  readFileSync(join(import.meta.dir, 'fixtures', 'outline', name), 'utf8');

describe('outline: parity with the plugin (#747 D9)', () => {
  it('takes Markdown headings outside code fences', () => {
    expect(outline(fixture('doc.md'), 'doc.md')).toEqual({
      entries: [
        [1, '# Title'],
        [5, '## Setup'],
        [14, '### Usage'],
        [18, '#### Deep heading'],
      ],
      more: 0,
    });
  });

  it('takes the unindented declarations of code, cut to 120 characters', () => {
    const { entries, more } = outline(fixture('sample.ts'), 'sample.ts');
    expect(more).toBe(0);
    expect(entries.map(([n]) => n)).toEqual([4, 8, 14, 16, 17, 22, 24, 29]);
    expect(entries[0]).toEqual([4, 'export interface Options {']);
    const last = entries.at(-1);
    expect(last?.[1]).toHaveLength(120);
    expect(last?.[1].startsWith("const aVeryLongDeclaration = 'xxx")).toBe(
      true,
    );
  });

  it('samples more than 40 entries evenly and counts the rest', () => {
    const text = Array.from(
      { length: 95 },
      (_, i) => `def f${i}():\n  pass\n`,
    ).join('');
    const { entries, more } = outline(text, 'big.py');
    expect(entries).toHaveLength(OUTLINE_MAX);
    expect(more).toBe(55);
    expect(entries.slice(0, 6).map(([n]) => n)).toEqual([1, 5, 9, 15, 19, 23]);
    expect(entries.at(-1)?.[0]).toBe(185);
  });

  it('has nothing to say about prose', () => {
    expect(outline(fixture('none.txt'), 'none.txt')).toEqual({
      entries: [],
      more: 0,
    });
    expect(renderOutline(fixture('none.txt'), 'none.txt')).toEqual([
      'No outline (no headings or top-level declarations found).',
    ]);
  });

  it('renders entries as `<line>: <text>` with the sampled note', () => {
    const text = Array.from({ length: 41 }, (_, i) => `fn f${i}() {}\n`).join(
      '',
    );
    const lines = renderOutline(text, 'a.rs');
    expect(lines[0]).toBe('Outline:');
    expect(lines[1]).toBe('  1: fn f0() {}');
    expect(lines.at(-1)).toBe('  (1 more, sampled)');
  });
});

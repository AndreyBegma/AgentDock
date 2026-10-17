import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from '../testing/fixtures';
import { readRegularFileInside } from './safe-read';

describe('readRegularFileInside', () => {
  let dir = '';
  let cleanup = () => {};
  beforeEach(() => {
    ({ dir, cleanup } = tempDir());
  });
  afterEach(() => cleanup());

  it('reads a regular file inside the root', () => {
    writeFileSync(join(dir, 'a.md'), 'hello');
    expect(readRegularFileInside(dir, 'a.md', 100)).toBe('hello');
  });

  it('refuses a symlink, to a file outside or inside the root', () => {
    mkdirSync(join(dir, 'wt'));
    writeFileSync(join(dir, 'secret'), 'secret');
    writeFileSync(join(dir, 'wt', 'real'), 'real');
    symlinkSync(join(dir, 'secret'), join(dir, 'wt', 'out.md'));
    symlinkSync(join(dir, 'wt', 'real'), join(dir, 'wt', 'in.md'));
    expect(readRegularFileInside(join(dir, 'wt'), 'out.md', 100)).toBeNull();
    expect(readRegularFileInside(join(dir, 'wt'), 'in.md', 100)).toBeNull();
  });

  it('refuses a file over the cap, and a missing one', () => {
    writeFileSync(join(dir, 'big.md'), Buffer.alloc(10 * 1024 * 1024));
    expect(readRegularFileInside(dir, 'big.md', 1024 * 1024)).toBeNull();
    expect(readRegularFileInside(dir, 'nope.md', 100)).toBeNull();
  });
});

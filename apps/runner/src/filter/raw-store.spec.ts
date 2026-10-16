import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FILTER_RAW_DIR, FILTER_STATS_FILE } from './env';
import { RawFile, removeRawDir } from './raw-store';

describe('raw store (#445 amendment 6, DR-07)', () => {
  let dir: string;
  const raw = () => join(dir, FILTER_RAW_DIR);
  const logs = () => readdirSync(raw()).sort();

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'raw-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps a run dir under its total cap, oldest files first', () => {
    mkdirSync(raw());
    for (let n = 1; n <= 5; n++) {
      writeFileSync(join(raw(), `${n}.log`), 'x'.repeat(100));
    }
    writeFileSync(join(raw(), 'notes.txt'), 'x'.repeat(1000));
    // Room for 300 bytes besides the new file's own cap of 100.
    const file = RawFile.create(dir, 100, 400);
    file.write(new TextEncoder().encode('new'));
    file.close();
    // 1 and 2 go; the new file takes the next free number after the listing.
    expect(logs().sort()).toEqual([
      '3.log',
      '4.log',
      '5.log',
      '7.log',
      'notes.txt',
    ]);
  });

  it('deletes nothing under the cap', () => {
    mkdirSync(raw());
    writeFileSync(join(raw(), '1.log'), 'x'.repeat(10));
    RawFile.create(dir, 100, 400).close();
    expect(logs()).toEqual(['1.log', '2.log']);
  });

  it('removes the raw outputs with the run, and nothing else', () => {
    RawFile.create(dir).close();
    writeFileSync(join(dir, FILTER_STATS_FILE), '');
    removeRawDir(dir);
    expect(existsSync(raw())).toBe(false);
    expect(existsSync(join(dir, FILTER_STATS_FILE))).toBe(true);
    // A second removal, or one of a dir that never had raw files, is fine.
    removeRawDir(dir);
    removeRawDir(join(dir, 'missing'));
  });
});

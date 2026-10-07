import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { acquireLock, LockError } from './lock';
import { tempDir } from './testing/fixtures';

/** A pid no process has: above Linux's pid_max ceiling (2^22). */
const DEAD_PID = 4_194_304 + 1;

describe('acquireLock', () => {
  let path = '';
  let cleanup = () => {};
  beforeEach(() => {
    const temp = tempDir();
    path = join(temp.dir, 'runner.lock');
    cleanup = temp.cleanup;
  });
  afterEach(() => cleanup());

  it('writes our pid and removes the file on release', () => {
    const release = acquireLock(path, 1234);
    expect(readFileSync(path, 'utf8')).toBe('1234\n');
    release();
    expect(existsSync(path)).toBe(false);
  });

  it('refuses while another live process holds it', () => {
    acquireLock(path, process.pid);
    expect(() => acquireLock(path, DEAD_PID)).toThrow(LockError);
    expect(() => acquireLock(path, DEAD_PID)).toThrow(`pid ${process.pid}`);
  });

  it('takes over a lock left by a dead process', () => {
    writeFileSync(path, `${DEAD_PID}\n`);
    acquireLock(path, 1234);
    expect(readFileSync(path, 'utf8')).toBe('1234\n');
  });
});

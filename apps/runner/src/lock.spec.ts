import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { acquireLock, LockError, processStart } from './lock';
import { tempDir } from './testing/fixtures';

/** A pid no process has: above Linux's pid_max ceiling (2^22). */
const DEAD_PID = 4_194_304 + 1;

const fake = (pid: number) => ({ pid, start: null });

describe('acquireLock', () => {
  let dir = '';
  let path = '';
  let cleanup = () => {};
  beforeEach(() => {
    const temp = tempDir();
    dir = temp.dir;
    path = join(temp.dir, 'runner.lock');
    cleanup = temp.cleanup;
  });
  afterEach(() => cleanup());

  it('writes our pid and removes the file on release', () => {
    const release = acquireLock(path, fake(1234));
    expect(readFileSync(path, 'utf8')).toBe('1234\n');
    release();
    expect(existsSync(path)).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('records the start time of the process by default', () => {
    acquireLock(path);
    expect(readFileSync(path, 'utf8')).toBe(
      `${process.pid} ${processStart(process.pid)}\n`,
    );
  });

  it('refuses while another live process holds it', () => {
    acquireLock(path);
    expect(() => acquireLock(path, fake(DEAD_PID))).toThrow(LockError);
    expect(() => acquireLock(path, fake(DEAD_PID))).toThrow(
      `pid ${process.pid}`,
    );
    expect(readdirSync(dir)).toEqual(['runner.lock']);
  });

  it('takes over a lock left by a dead process', () => {
    writeFileSync(path, `${DEAD_PID}\n`);
    acquireLock(path, fake(1234));
    expect(readFileSync(path, 'utf8')).toBe('1234\n');
    expect(readdirSync(dir)).toEqual(['runner.lock']);
  });

  it('takes over a lock whose pid now names a later process', () => {
    writeFileSync(path, `${process.pid} not-its-start-time\n`);
    acquireLock(path, fake(1234));
    expect(readFileSync(path, 'utf8')).toBe('1234\n');
  });

  it('refuses a takeover while a live process is taking it over', () => {
    writeFileSync(path, `${DEAD_PID}\n`);
    writeFileSync(`${path}.takeover`, `${process.pid}\n`);
    expect(() => acquireLock(path, fake(1234))).toThrow('is starting');
    expect(readFileSync(path, 'utf8')).toBe(`${DEAD_PID}\n`);
  });

  it('clears a takeover a dead process left behind', () => {
    writeFileSync(path, `${DEAD_PID}\n`);
    writeFileSync(`${path}.takeover`, `${DEAD_PID}\n`);
    acquireLock(path, fake(1234));
    expect(readFileSync(path, 'utf8')).toBe('1234\n');
    expect(readdirSync(dir)).toEqual(['runner.lock']);
  });

  it('does not remove a lock another process took on release', () => {
    const release = acquireLock(path, fake(1234));
    writeFileSync(path, '5678\n');
    release();
    expect(readFileSync(path, 'utf8')).toBe('5678\n');
  });

  it('leaves exactly one holder when two daemons take over a stale lock at once', async () => {
    const script = `
      const { acquireLock, LockError } = require(${JSON.stringify(join(import.meta.dir, 'lock.ts'))});
      try {
        acquireLock(${JSON.stringify(path)});
      } catch (error) {
        process.exit(error instanceof LockError ? 1 : 2);
      }
      setTimeout(() => process.exit(0), 500);
    `;
    for (let round = 0; round < 3; round++) {
      writeFileSync(path, `${DEAD_PID}\n`);
      const children = [0, 1].map(() =>
        Bun.spawn([process.execPath, '-e', script], {
          stdout: 'ignore',
          stderr: 'ignore',
        }),
      );
      const codes = await Promise.all(children.map((c) => c.exited));
      const winner = children[codes.indexOf(0)];
      expect([...codes].sort()).toEqual([0, 1]);
      expect(readFileSync(path, 'utf8')).toStartWith(`${winner?.pid} `);
    }
  });
});

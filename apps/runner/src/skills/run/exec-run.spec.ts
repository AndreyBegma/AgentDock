import { afterEach, describe, expect, it } from 'bun:test';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from '../../testing/fixtures';
import { execRun } from './exec-run';

let cleanup = () => {};
afterEach(() => cleanup());

const io = () => {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: {
      env: { PATH: process.env.PATH, KEPT: 'from-tmux' },
      stdout: (t: string) => out.push(t),
      stderr: (t: string) => err.push(t),
      now: () => new Date('2026-10-09T12:00:00.000Z'),
    },
  };
};

const runDir = () => {
  const t = tempDir();
  cleanup = t.cleanup;
  return t.dir;
};

describe('exec-run', () => {
  it('spawns the argv, streams stdout and stderr to files and records the exit', async () => {
    const dir = runDir();
    const binary = join(dir, 'fake');
    writeFileSync(
      binary,
      '#!/bin/sh\necho "{\\"argv\\":\\"$1|$2\\",\\"kept\\":\\"$KEPT\\",\\"set\\":\\"$SET\\",\\"cwd\\":\\"$(pwd)\\"}"\necho oops >&2\nexit 3\n',
    );
    chmodSync(binary, 0o755);
    writeFileSync(
      join(dir, 'run.json'),
      JSON.stringify({
        binary,
        // One argv element each, with shell metacharacters left alone.
        args: ['-p', '/estimate $(rm -rf ~); `x`'],
        env: { SET: 'by-run' },
        cwd: dir,
      }),
    );
    const { io: ioDeps } = io();
    expect(await execRun([dir], ioDeps)).toBe(3);
    expect(JSON.parse(readFileSync(join(dir, 'stream.jsonl'), 'utf8'))).toEqual(
      {
        argv: '-p|/estimate $(rm -rf ~); `x`',
        kept: 'from-tmux',
        set: 'by-run',
        cwd: dir,
      },
    );
    expect(readFileSync(join(dir, 'stderr.log'), 'utf8')).toBe('oops\n');
    expect(JSON.parse(readFileSync(join(dir, 'exit.json'), 'utf8'))).toEqual({
      code: 3,
      signal: null,
      at: '2026-10-09T12:00:00.000Z',
    });
  });

  it('records 127 when the binary is not on PATH', async () => {
    const dir = runDir();
    writeFileSync(
      join(dir, 'run.json'),
      JSON.stringify({
        binary: 'no-such-claude-binary',
        args: [],
        env: {},
        cwd: dir,
      }),
    );
    const { io: ioDeps, err } = io();
    expect(await execRun([dir], ioDeps)).toBe(127);
    expect(err.join('')).toContain('not on PATH');
    expect(JSON.parse(readFileSync(join(dir, 'exit.json'), 'utf8')).code).toBe(
      127,
    );
  });

  it('refuses a missing run.json and a relative directory', async () => {
    const dir = runDir();
    const { io: ioDeps } = io();
    expect(await execRun([dir], ioDeps)).toBe(1);
    expect(existsSync(join(dir, 'exit.json'))).toBe(false);
    expect(await execRun(['relative/dir'], ioDeps)).toBe(2);
    expect(await execRun([], ioDeps)).toBe(2);
  });
});

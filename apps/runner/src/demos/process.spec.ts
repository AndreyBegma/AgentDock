import { describe, expect, it } from 'bun:test';
import { spawn as spawnChild } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createExec } from '../detect/exec';
import {
  createDemoflowSpawn,
  createProcessLister,
  freePort,
  ProcessTree,
  parseProcStat,
  portInUse,
  readProcTable,
} from './process';

const env = { PATH: process.env.PATH ?? '/usr/bin:/bin' };
const exec = createExec(env);
const hasSetsid = Bun.which('setsid', env) !== null;

const running = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const gone = async (pid: number): Promise<boolean> => {
  for (let i = 0; i < 50; i += 1) {
    if (!running(pid)) return true;
    await new Promise((done) => setTimeout(done, 20));
  }
  return false;
};

const spawn = createDemoflowSpawn(exec, { pollMs: 20, killGraceMs: 200 });

describe.if(hasSetsid)('createDemoflowSpawn', () => {
  it('kills the whole tree past the time limit, a new session included', async () => {
    // `setsid` puts the "app" in a session of its own, as DemoFlow does.
    const exit = await spawn(
      'sh',
      ['-c', 'setsid sleep 30 & echo $!; sleep 30'],
      { cwd: '/', env, timeoutMs: 400 },
    );
    expect(exit.timedOut).toBe(true);
    const app = Number(exit.stdout.trim());
    expect(app).toBeGreaterThan(0);
    expect(await gone(app)).toBe(true);
  });

  it('kills what DemoFlow left running when it ends on its own', async () => {
    const exit = await spawn(
      'sh',
      ['-c', 'setsid sleep 30 & echo $!; sleep 0.3; echo done >&2; exit 2'],
      { cwd: '/', env, timeoutMs: 10_000 },
    );
    expect(exit.timedOut).toBe(false);
    expect(exit.code).toBe(2);
    expect(exit.stderr).toBe('done\n');
    expect(await gone(Number(exit.stdout.trim()))).toBe(true);
  });

  it('gives the process exactly the environment it is handed', async () => {
    const exit = await spawn('sh', ['-c', 'echo "$PORT:$SECRET:$HOME"'], {
      cwd: '/',
      env: { ...env, PORT: '3000', SECRET: 's3' },
      timeoutMs: 5_000,
    });
    expect(exit.stdout).toBe('3000:s3:\n');
  });
});

describe('parseProcStat', () => {
  it('reads the parent pid after the last parenthesis of the command name', () => {
    expect(parseProcStat('42 (node) S 7 42 42 0 -1')).toBe(7);
    expect(parseProcStat('43 (my (odd) app) R 1 43 43 0 -1')).toBe(1);
    expect(parseProcStat('garbage')).toBeNull();
  });
});

describe('readProcTable', () => {
  const fixture = (files: Record<string, string>): string => {
    const root = mkdtempSync(join(tmpdir(), 'proc-'));
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(join(root, path, '..'), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    return root;
  };

  it('reads pid, parent and command line, skipping what is not a process', async () => {
    const root = fixture({
      '1/stat': '1 (init) S 0 1 1 0 -1',
      '1/cmdline': '/sbin/init\0',
      '42/stat': '42 (node (app)) S 1 42 42 0 -1',
      '42/cmdline': 'node\0server.js\0--port\0 3000\0',
      '2/stat': '2 (kthreadd) S 0 0 0 0 -1',
      '2/cmdline': '',
      // Exited between the listing and the read.
      '77/cmdline': 'gone\0',
      'self/stat': '1 (init) S 0 1 1 0 -1',
      'meminfo/x': '',
    });
    try {
      const table = await readProcTable(root);
      expect(table && [...table].sort(([a], [b]) => a - b)).toEqual([
        [1, { ppid: 0, args: '/sbin/init' }],
        [2, { ppid: 0, args: '[kthreadd]' }],
        [42, { ppid: 1, args: 'node server.js --port  3000' }],
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('is null when the directory cannot be listed', async () => {
    expect(await readProcTable('/nonexistent/proc')).toBeNull();
  });

  it.if(process.platform === 'linux')(
    'lists this process from /proc',
    async () => {
      const table = await readProcTable();
      expect(table?.get(process.pid)?.ppid).toBe(process.ppid);
    },
  );
});

describe('createProcessLister', () => {
  it('falls back to ps off Linux', async () => {
    const calls: string[][] = [];
    const list = createProcessLister(async (binary, args) => {
      calls.push([binary, ...args]);
      return { code: 0, stdout: ' 5 1 app --x\n', stderr: '' };
    }, 'darwin');
    expect(await list()).toEqual(new Map([[5, { ppid: 1, args: 'app --x' }]]));
    expect(calls).toEqual([['ps', '-eo', 'pid=,ppid=,args=']]);
  });

  it('is null when ps is missing too', async () => {
    const list = createProcessLister(async () => null, 'darwin');
    expect(await list()).toBeNull();
  });
});

describe('ProcessTree without a process table', () => {
  it('reports it and kills the root process group', async () => {
    const child = spawnChild('sh', ['-c', 'sleep 30 & sleep 30'], {
      detached: true,
      stdio: 'ignore',
    });
    const pid = child.pid as number;
    let unlisted = 0;
    const tree = new ProcessTree(
      async () => null,
      pid,
      () => {
        unlisted += 1;
      },
    );
    expect(await tree.kill(100)).toBe(1);
    expect(unlisted).toBeGreaterThan(0);
    expect(await gone(pid)).toBe(true);
  });
});

describe('ports', () => {
  it('sees a taken port and a free one', async () => {
    const port = await freePort();
    expect(await portInUse(port)).toBe(false);
    const server = createServer();
    await new Promise<void>((done) => server.listen(port, '127.0.0.1', done));
    try {
      expect(await portInUse(port)).toBe(true);
    } finally {
      server.close();
    }
  });
});

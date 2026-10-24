import { describe, expect, it } from 'bun:test';
import { spawn as spawnChild } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createExec } from '../detect/exec';
import {
  createDemoflowSpawn,
  createProcessLister,
  freePort,
  type ProcessTable,
  ProcessTree,
  parseProcSession,
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
/** A run waits out the pipe drain and the kill grace; slower under load. */
const SPAWN_TEST_MS = 20_000;

describe.if(hasSetsid)('createDemoflowSpawn', () => {
  it(
    'kills the whole tree past the time limit, a new session included',
    async () => {
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
    },
    SPAWN_TEST_MS,
  );

  // C-384: the "app" writes its pid to `app`; the root waits for a file
  // before it exits, so nothing depends on how fast the machine is.
  const until = (file: string) =>
    `while [ ! -s "$0/${file}" ]; do sleep 0.01; done`;
  const appPid = (dir: string): number => {
    try {
      return Number(readFileSync(join(dir, 'app'), 'utf8').trim()) || 0;
    } catch {
      return 0;
    }
  };

  it(
    'kills what DemoFlow left running in a new session once it was seen',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'demo-tree-'));
      const lister = createProcessLister(exec);
      // `ready` once a listing has the app in it, while the root still runs.
      const list = async () => {
        const table = await lister();
        if (appPid(dir) > 0 && table?.has(appPid(dir))) {
          writeFileSync(join(dir, 'ready'), 'seen');
        }
        return table;
      };
      try {
        const exit = await createDemoflowSpawn(exec, {
          list,
          pollMs: 20,
          killGraceMs: 200,
        })(
          'sh',
          [
            '-c',
            `setsid sh -c 'echo $$ > "$0/app"; exec sleep 30' "$0" & ${until('ready')}; echo done >&2; exit 2`,
            dir,
          ],
          { cwd: '/', env, timeoutMs: 10_000 },
        );
        expect(exit.timedOut).toBe(false);
        expect(exit.code).toBe(2);
        expect(exit.stderr).toBe('done\n');
        expect(await gone(appPid(dir))).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    SPAWN_TEST_MS,
  );

  it(
    'kills what DemoFlow left running in its session, never listed while the root ran',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'demo-tree-'));
      try {
        // Polls too rare to see the app before the root exits.
        const exit = await createDemoflowSpawn(exec, {
          pollMs: 60_000,
          killGraceMs: 200,
        })(
          'sh',
          [
            '-c',
            `sh -c 'echo $$ > "$0/app"; exec sleep 30' "$0" & ${until('app')}; exit 0`,
            dir,
          ],
          { cwd: '/', env, timeoutMs: 10_000 },
        );
        expect(exit.timedOut).toBe(false);
        expect(exit.code).toBe(0);
        expect(await gone(appPid(dir))).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    SPAWN_TEST_MS,
  );

  it(
    'gives the process exactly the environment it is handed',
    async () => {
      const exit = await spawn('sh', ['-c', 'echo "$PORT:$SECRET:$HOME"'], {
        cwd: '/',
        env: { ...env, PORT: '3000', SECRET: 's3' },
        timeoutMs: 5_000,
      });
      expect(exit.stdout).toBe('3000:s3:\n');
    },
    SPAWN_TEST_MS,
  );
});

describe('parseProcStat', () => {
  it('reads the parent pid after the last parenthesis of the command name', () => {
    expect(parseProcStat('42 (node) S 7 42 42 0 -1')).toBe(7);
    expect(parseProcStat('43 (my (odd) app) R 1 43 43 0 -1')).toBe(1);
    expect(parseProcStat('garbage')).toBeNull();
  });

  it('reads the session id two fields after the parent', () => {
    expect(parseProcSession('42 (node) S 7 40 39 0 -1')).toBe(39);
    expect(parseProcSession('43 (my (odd) app) R 1 43 41 0 -1')).toBe(41);
    expect(parseProcSession('44 (short) S 1')).toBeNull();
  });
});

describe('ProcessTree sessions', () => {
  const tableOf = (rows: [number, number, string, number?][]): ProcessTable =>
    new Map(
      rows.map(([pid, ppid, args, sid]) => [
        pid,
        sid === undefined ? { ppid, args } : { ppid, args, sid },
      ]),
    );

  it('finds a process reparented unseen when it kept a session the tree owns', async () => {
    // The root (100) and an app it started in a session of its own.
    let table = tableOf([
      [1, 0, 'init', 1],
      [100, 1, 'demoflow', 100],
      [200, 100, 'app', 200],
    ]);
    const tree = new ProcessTree(async () => table, 100);
    await tree.poll();
    // The root exited; what it and the app left behind went to init unseen.
    table = tableOf([
      [1, 0, 'init', 1],
      [200, 1, 'app', 200],
      [300, 1, 'worker of the root', 100],
      [400, 1, 'worker of the app', 200],
      [500, 1, 'someone else', 500],
      [600, 1, 'no session known'],
    ]);
    await tree.poll();
    expect(await tree.alive()).toEqual([200, 300, 400]);
  });

  it('keeps a process that execs another command line, not a reused pid', async () => {
    let table: ProcessTable = new Map([
      [100, { ppid: 1, args: 'demoflow', sid: 100, start: 10 }],
      [200, { ppid: 100, args: 'sh -c exec app', sid: 100, start: 11 }],
      [300, { ppid: 100, args: 'old', sid: 100, start: 12 }],
    ]);
    const tree = new ProcessTree(async () => table, 100);
    await tree.poll();
    table = new Map([
      [200, { ppid: 1, args: 'app', sid: 100, start: 11 }],
      [300, { ppid: 1, args: 'old', sid: 999, start: 99 }],
    ]);
    expect(await tree.alive()).toEqual([200]);
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
      '42/stat':
        '42 (node (app)) S 1 42 42 0 -1 4194304 1 0 0 0 0 0 0 0 20 0 1 0 5678 1',
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
        [1, { ppid: 0, args: '/sbin/init', sid: 1 }],
        [2, { ppid: 0, args: '[kthreadd]', sid: 0 }],
        [
          42,
          {
            ppid: 1,
            args: 'node server.js --port  3000',
            sid: 42,
            start: 5678,
          },
        ],
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

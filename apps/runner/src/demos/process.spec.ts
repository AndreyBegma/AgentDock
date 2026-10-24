import { describe, expect, it } from 'bun:test';
import { createServer } from 'node:net';
import { createExec } from '../detect/exec';
import { createDemoflowSpawn, freePort, portInUse } from './process';

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

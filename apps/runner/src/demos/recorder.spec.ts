import { afterEach, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type CardDemoArgs,
  type DemoflowStatus,
  type UnsequencedEvent,
  watchedProjectSchema,
} from '@nautelle/shared/protocol';
import { cardWorktreePath } from '../cards/launch';
import { systemClock } from '../clock';
import { CommandFailure } from '../commands/failure';
import { fakeExec, memoryLogger, TOKEN, tempDir } from '../testing/fixtures';
import { DEMOFLOW_PACKAGE } from './pin';
import type { DemoflowExit, DemoflowSpawn } from './process';
import {
  DEMO_QUEUE_MAX,
  DemoRecorder,
  type DemoRecorderDeps,
  type PortProbes,
  planPort,
} from './recorder';

const SECRET = 'hunter2-very-secret';
const SHORT_ID = 'abcd1234';
const SCENARIO = 'demoflow/cards/C-7-add-login.demo.json';
const VIDEO = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 1, 2, 3]);

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

interface Call {
  binary: string;
  args: readonly string[];
  env: Record<string, string>;
  cwd: string;
  timeoutMs: number;
}

/** A DemoFlow that renders `VIDEO` into `--out` and prints its summary. */
const rendering =
  (calls: Call[], override?: Partial<DemoflowExit>): DemoflowSpawn =>
  async (binary, args, options) => {
    calls.push({ binary, args, ...options });
    const out = args[args.indexOf('--out') + 1];
    const runDir = join(out, 'runs', 'r1');
    mkdirSync(join(runDir, 'render'), { recursive: true });
    writeFileSync(join(runDir, 'render', 'ffmpeg.mp4'), VIDEO);
    const summary = {
      schemaVersion: 1,
      runId: 'r1',
      status: 'completed',
      stages: { readiness: { status: 'completed' } },
      renders: [
        {
          renderer: 'ffmpeg',
          format: 'mp4',
          file: 'render/ffmpeg.mp4',
          durationMs: 4200.4,
          sizeBytes: VIDEO.byteLength,
        },
      ],
      warnings: [],
      runDir,
    };
    return {
      code: 0,
      stdout: `${JSON.stringify(summary)}\n`,
      stderr: '',
      timedOut: false,
      ...override,
    };
  };

const failing =
  (calls: Call[]): DemoflowSpawn =>
  async (binary, args, o) => {
    calls.push({ binary, args, ...o });
    const summary = {
      schemaVersion: 1,
      status: 'failed',
      stages: {
        readiness: { status: 'completed' },
        execution: {
          status: 'failed',
          error: {
            message: `locator "#password" not found after typing ${SECRET}`,
            stepIndex: 2,
          },
        },
      },
      renders: [],
      runDir: '/nowhere',
    };
    return {
      code: 1,
      stdout: JSON.stringify(summary),
      stderr: '',
      timedOut: false,
    };
  };

interface Request {
  url: string;
  init: RequestInit;
}

const api = (
  answers: ((req: Request) => Response)[],
  requests: Request[],
): typeof fetch =>
  (async (url: string | URL | Request, init?: RequestInit) => {
    const req = { url: String(url), init: init ?? {} };
    requests.push(req);
    if (req.url.endsWith('/env')) {
      return Response.json({ env: { LOGIN_PASSWORD: SECRET, OTHER: 'x' } });
    }
    const answer = answers.shift();
    return answer ? answer(req) : new Response(null, { status: 201 });
  }) as typeof fetch;

const ready: DemoflowStatus = { version: '0.4.0', ready: true };

const setup = (
  options: {
    spawn?: DemoflowSpawn;
    probes?: Partial<PortProbes>;
    features?: { portTemplating: boolean };
    answers?: ((req: Request) => Response)[];
    provisioned?: DemoflowStatus;
    scenario?: boolean;
    config?: unknown;
  } = {},
) => {
  const { dir, cleanup } = tempDir();
  cleanups.push(cleanup);
  const root = join(dir, 'shop');
  mkdirSync(root);
  const worktree = cardWorktreePath(root, SHORT_ID);
  mkdirSync(join(worktree, 'demoflow', 'cards'), { recursive: true });
  writeFileSync(
    join(worktree, 'demoflow.config.json'),
    JSON.stringify(
      options.config ?? {
        baseUrl: 'http://localhost:3000',
        devCommand: {
          command: 'bun',
          args: ['run', 'dev'],
          readyUrl: 'http://localhost:3000',
        },
      },
    ),
  );
  if (options.scenario !== false) {
    writeFileSync(join(worktree, SCENARIO), '{"steps":[]}');
  }
  const events: UnsequencedEvent[] = [];
  const requests: Request[] = [];
  const calls: Call[] = [];
  const logger = memoryLogger();
  const sleeps: number[] = [];
  const deps: DemoRecorderDeps = {
    exec: fakeExec({}),
    log: logger.log,
    clock: systemClock,
    emit: (event) => events.push(event),
    watchedProjects: () => [watchedProjectSchema.parse({ id: 'p1', root })],
    provisioner: { ensure: async () => options.provisioned ?? ready },
    api: {
      server: 'https://nautelle.example',
      token: TOKEN,
      fetch: api(options.answers ?? [], requests),
    },
    env: { PATH: '/usr/bin', HOME: '/home/someone', UNSET: undefined },
    workDir: join(dir, 'demos'),
    spawn: options.spawn ?? rendering(calls),
    probes: {
      portInUse: async () => false,
      freePort: async () => 41234,
      ...options.probes,
    },
    features: options.features ?? { portTemplating: false },
    upload: {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    },
  };
  const recorder = new DemoRecorder(deps);
  const args = (demoId = 'demo1'): CardDemoArgs => ({
    cardId: 'card1',
    projectId: 'p1',
    card: 7,
    round: 2,
    demoId,
    worktree: { root, shortId: SHORT_ID },
    scenario: SCENARIO,
    env: ['LOGIN_PASSWORD'],
  });
  return {
    recorder,
    args,
    events,
    requests,
    calls,
    sleeps,
    lines: logger.lines,
    worktree,
  };
};

const statuses = (events: UnsequencedEvent[]) =>
  events.map((e) => {
    const data = e.data as { status: string; reason?: string };
    return data.reason ? `${data.status}: ${data.reason}` : data.status;
  });

describe('DemoRecorder', () => {
  it('refuses a project the runner does not watch (the allowlist)', () => {
    const { recorder, args } = setup();
    const outside = { ...args(), projectId: 'p2' };
    expect(() => recorder.command(outside)).toThrow(CommandFailure);
  });

  it('records, uploads the MP4 with its SHA-256, and reports recording only', async () => {
    const { recorder, args, events, requests, calls, worktree } = setup();
    expect(recorder.command(args())).toEqual({ status: 'recording' });
    await recorder.idle();

    expect(statuses(events)).toEqual(['recording']);
    expect(events[0]).toMatchObject({
      type: 'demo.status',
      source: 'runner',
      project: { repo: 'shop' },
      data: { demoId: 'demo1', scenarioPath: SCENARIO },
    });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call.binary).toBe('npx');
    expect(call.args.slice(0, 4)).toEqual([
      '--yes',
      DEMOFLOW_PACKAGE,
      'run',
      SCENARIO,
    ]);
    expect(call.args).toContain('--json');
    expect(call.args.join(' ')).toContain('--format mp4');
    expect(call.cwd.endsWith(`.wt-shop-card-${SHORT_ID}`)).toBe(true);
    expect(call.cwd).toBe(worktree);
    expect(call.timeoutMs).toBe(10 * 60_000);

    const upload = requests.find((r) => r.url.endsWith('/video'));
    expect(upload?.url).toBe(
      'https://nautelle.example/runner/cards/7/demos/demo1/video',
    );
    const headers = upload?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(headers['Content-Type']).toBe('video/mp4');
    expect(headers['x-demo-sha256']).toBe(
      createHash('sha256').update(VIDEO).digest('hex'),
    );
    expect(headers['x-demo-duration-ms']).toBe('4200');
    expect(upload?.init.redirect).toBe('error');
  });

  it('hands secrets to the process env only — never args, events or logs', async () => {
    const { recorder, args, events, calls, lines } = setup();
    recorder.command(args());
    await recorder.idle();

    const [call] = calls;
    expect(call.env.LOGIN_PASSWORD).toBe(SECRET);
    // Only the names the command lists, not every project secret.
    expect(call.env.OTHER).toBeUndefined();
    expect(call.env.PORT).toBe('3000');
    expect(call.env.PATH).toBe('/usr/bin');
    expect('UNSET' in call.env).toBe(false);
    expect(call.args.join(' ')).not.toContain(SECRET);
    expect(JSON.stringify(events)).not.toContain(SECRET);
    expect(lines.join('\n')).not.toContain(SECRET);
  });

  it('refuses when the app port is already taken (DemoFlow 0.4.0)', async () => {
    const { recorder, args, events, calls } = setup({
      probes: { portInUse: async (port) => port === 3000 },
    });
    recorder.command(args());
    await recorder.idle();
    expect(calls).toHaveLength(0);
    expect(statuses(events)).toEqual([
      expect.stringMatching(/^failed: port 3000 .* already in use/),
    ]);
  });

  it('assigns a free port and passes it as the base URL with port templating', async () => {
    const calls: Call[] = [];
    const { recorder, args } = setup({
      spawn: rendering(calls),
      features: { portTemplating: true },
      probes: { portInUse: async () => true },
    });
    recorder.command(args());
    await recorder.idle();
    expect(calls[0].env.PORT).toBe('41234');
    expect(calls[0].args.join(' ')).toContain(
      '--base-url http://127.0.0.1:41234 --fresh-app',
    );
  });

  it('skips a card with no scenario, without starting DemoFlow', async () => {
    const { recorder, args, events, calls } = setup({ scenario: false });
    recorder.command(args());
    await recorder.idle();
    expect(calls).toHaveLength(0);
    expect(statuses(events)).toEqual([
      `skipped: the card has no scenario at ${SCENARIO}`,
    ]);
    expect(events[0].data).not.toHaveProperty('scenarioPath');
  });

  it('fails with the failed stage and step, the secret masked', async () => {
    const calls: Call[] = [];
    const { recorder, args, events } = setup({ spawn: failing(calls) });
    recorder.command(args());
    await recorder.idle();
    expect(statuses(events)).toEqual([
      'recording',
      'failed: DemoFlow execution failed at step 3: locator "#password" not found after typing •••',
    ]);
  });

  it('fails a recording that passed the time limit', async () => {
    const calls: Call[] = [];
    const { recorder, args, events } = setup({
      spawn: rendering(calls, { timedOut: true, code: null, stdout: '' }),
    });
    recorder.command(args());
    await recorder.idle();
    expect(statuses(events)).toEqual([
      'recording',
      'failed: the recording passed the 10-minute limit and was stopped',
    ]);
  });

  it('fails without a summary, redacting what DemoFlow printed', async () => {
    const calls: Call[] = [];
    const { recorder, args, events } = setup({
      spawn: rendering(calls, {
        code: 3,
        stdout: '',
        stderr: `boom: password was ${SECRET}\n`,
      }),
    });
    recorder.command(args());
    await recorder.idle();
    const reason = statuses(events)[1];
    expect(reason).toStartWith('failed: DemoFlow exited with code 3');
    expect(reason).not.toContain(SECRET);
  });

  it('fails when DemoFlow is not ready', async () => {
    const { recorder, args, events, calls } = setup({
      provisioned: { version: '0.4.0', ready: false, reason: 'no Chromium' },
    });
    recorder.command(args());
    await recorder.idle();
    expect(calls).toHaveLength(0);
    expect(statuses(events)).toEqual([
      'recording',
      'failed: DemoFlow is not ready: no Chromium',
    ]);
  });

  it('fails without a devCommand: it records only an app it starts', async () => {
    const { recorder, args, events } = setup({
      config: { baseUrl: 'http://localhost:3000' },
    });
    recorder.command(args());
    await recorder.idle();
    expect(statuses(events)[0]).toStartWith(
      'failed: demoflow.config.json has no devCommand',
    );
  });

  it('retries the upload on 5xx and network errors, then succeeds', async () => {
    const { recorder, args, events, requests, sleeps } = setup({
      answers: [
        () => new Response(null, { status: 503 }),
        () => {
          throw new TypeError('fetch failed');
        },
      ],
    });
    recorder.command(args());
    await recorder.idle();
    expect(requests.filter((r) => r.url.endsWith('/video'))).toHaveLength(3);
    expect(sleeps).toEqual([2_000, 10_000]);
    expect(statuses(events)).toEqual(['recording']);
  });

  it('gives up after three tries and reports the upload failed', async () => {
    const down = () => new Response(null, { status: 502 });
    const { recorder, args, events } = setup({ answers: [down, down, down] });
    recorder.command(args());
    await recorder.idle();
    expect(statuses(events)).toEqual([
      'recording',
      'failed: the video upload failed after 3 tries: HTTP 502',
    ]);
  });

  it('drops a demo the API no longer has active, reporting nothing', async () => {
    const { recorder, args, events } = setup({
      answers: [
        () =>
          Response.json(
            { statusCode: 409, error: 'demo_not_active', message: 'gone' },
            { status: 409 },
          ),
      ],
    });
    recorder.command(args());
    await recorder.idle();
    expect(statuses(events)).toEqual(['recording']);
  });

  it('records one demo at a time; the others queue in order', async () => {
    let release = () => {};
    const gate = new Promise<void>((done) => {
      release = done;
    });
    const calls: Call[] = [];
    const render = rendering(calls);
    const order: string[] = [];
    const { recorder, args } = setup({
      spawn: async (binary, argv, options) => {
        order.push(`start ${calls.length}`);
        if (calls.length === 0) await gate;
        const exit = await render(binary, argv, options);
        order.push(`end ${calls.length}`);
        return exit;
      },
    });
    expect(recorder.command(args('a'))).toEqual({ status: 'recording' });
    expect(recorder.command(args('b'))).toEqual({ status: 'queued' });
    // The same demo again is the same answer, not a second recording.
    expect(recorder.command(args('b'))).toEqual({ status: 'queued' });
    await new Promise((done) => setTimeout(done, 20));
    expect(order).toEqual(['start 0']);
    release();
    await recorder.idle();
    expect(order).toEqual(['start 0', 'end 1', 'start 1', 'end 2']);
  });

  it(`answers busy past ${DEMO_QUEUE_MAX} waiting demos`, () => {
    const never: DemoflowSpawn = () => new Promise(() => {});
    const { recorder, args } = setup({ spawn: never });
    for (let i = 0; i <= DEMO_QUEUE_MAX; i += 1)
      recorder.command(args(`d${i}`));
    expect(() => recorder.command(args('one-more'))).toThrow(/already waiting/);
  });
});

describe('planPort', () => {
  const probes: PortProbes = {
    portInUse: async () => false,
    freePort: async () => 40000,
  };
  const config = (readyUrl: string) => ({
    baseUrl: readyUrl,
    devCommand: { command: 'bun', readyUrl },
  });

  it("uses the readyUrl's port, or the scheme's default", async () => {
    expect(
      await planPort(
        config('http://127.0.0.1:5173/health'),
        {
          portTemplating: false,
        },
        probes,
      ),
    ).toEqual({ port: 5173, args: [] });
    expect(
      await planPort(
        config('http://localhost/'),
        { portTemplating: false },
        probes,
      ),
    ).toEqual({ port: 80, args: [] });
  });

  it('refuses an app that is not on this machine', async () => {
    expect(
      await planPort(
        config('https://staging.example.com'),
        { portTemplating: false },
        probes,
      ),
    ).toMatch(/not on this machine/);
  });
});

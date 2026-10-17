import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { filterStatRowSchema } from '@agentdock/shared';
import { type FilterDeps, judge, runFilter } from './engine';
import { filterEnv, RAW_ENV } from './env';
import { RAW_CAP_BYTES, RAW_TRUNCATED_MARKER } from './raw-store';
import type { StatsLine } from './stats';
import { demoFilter, lossyFilter, tapOutput, throwingFilter } from './testing';

const FAILURES = [
  'not ok 201 - drops the oldest segment at the cap',
  '  Error: expected 3 segments, got 4',
  '      at dropOldest (src/spool.ts:212:11)',
];

describe('filter -- <argv> (#445 D3, D4)', () => {
  let dir: string;
  let out: { stream: 'out' | 'err'; text: string }[];
  let deps: FilterDeps;

  const script = (name: string, body: string): string => {
    const path = join(dir, name);
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
    return path;
  };
  const printed = () => out.map((o) => o.text).join('');
  const stats = (): StatsLine[] => {
    const file = join(dir, 'filter-stats.jsonl');
    if (!existsSync(file)) return [];
    return readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as StatsLine);
  };
  const rawFiles = () =>
    existsSync(join(dir, 'raw')) ? readdirSync(join(dir, 'raw')).sort() : [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'filter-'));
    out = [];
    const decoder = new TextDecoder();
    const sink = (stream: 'out' | 'err') => (bytes: Uint8Array | string) =>
      out.push({
        stream,
        text: typeof bytes === 'string' ? bytes : decoder.decode(bytes),
      });
    deps = {
      env: {
        PATH: process.env.PATH,
        ...filterEnv({
          runDir: dir,
          projectId: 'p1',
          runId: 'r1',
          runKind: 'card',
        }),
      },
      filters: [demoFilter, lossyFilter, throwingFilter],
      stdout: sink('out'),
      stderr: sink('err'),
      now: () => Date.parse('2026-10-16T12:00:00.000Z'),
      onSignal: () => () => {},
    };
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('compresses a covered command, keeps every error line, the exit code and the raw output', async () => {
    const output = tapOutput(200, FAILURES);
    writeFileSync(join(dir, 'expected.txt'), output);
    const demo = script(
      'demo.sh',
      `cat "${join(dir, 'expected.txt')}"\nexit 1`,
    );

    const code = await runFilter([demo], deps);

    expect(code).toBe(1);
    const text = printed();
    for (const line of [...FAILURES, '200 passed, 3 failed']) {
      expect(text).toContain(line);
    }
    expect(text).not.toContain('ok 17 -');
    const rawPath = join(dir, 'raw', '1.log');
    expect(text).toEndWith(
      `[agentdock filter: 200 lines hidden · full output: ${rawPath} · AGENTDOCK_RAW=1 to bypass]\n`,
    );
    // The raw file is the original, byte for byte.
    expect(readFileSync(rawPath, 'utf8')).toBe(output);

    const [line] = stats();
    expect(line?.projectId).toBe('p1');
    expect(filterStatRowSchema.safeParse(line?.row).success).toBe(true);
    expect(line?.row).toMatchObject({
      runId: 'r1',
      runKind: 'card',
      filter: 'fixture/demo',
      rawBytes: Buffer.byteLength(output),
      keptBytes: Buffer.byteLength(text),
      bypassed: false,
      passedThrough: false,
    });
    const ratio = (line?.row.keptBytes ?? 1) / (line?.row.rawBytes ?? 1);
    expect(ratio).toBeLessThan(0.1);
  });

  it('redacts what the agent reads, never the raw file (DR-07)', async () => {
    // Built at run time, so no scanner takes the fixture for a real token.
    const token = `ghp_${'A1b2'.repeat(9)}`;
    const failures = [
      'not ok 201 - pushes with the token',
      `  Error: remote rejected https://x-access-token:${token}@github.com/acme/x`,
    ];
    const output = tapOutput(200, failures);
    writeFileSync(join(dir, 'expected.txt'), output);
    const demo = script(
      'demo.sh',
      `cat "${join(dir, 'expected.txt')}"\nexit 1`,
    );

    expect(await runFilter([demo], deps)).toBe(1);

    const text = printed();
    expect(text).not.toContain(token);
    expect(text).toContain('https://***@github.com/acme/x');
    expect(readFileSync(join(dir, 'raw', '1.log'), 'utf8')).toBe(output);
    expect(stats()[0]?.row.keptBytes).toBe(Buffer.byteLength(text));
  });

  it('numbers raw files per command', async () => {
    const demo = script(
      'demo.sh',
      `printf 'ok 1 - a\\nok 2 - b\\nok 3 - c\\nok 4 - d\\n'`,
    );
    await runFilter([demo], deps);
    await runFilter([demo], deps);
    expect(rawFiles()).toEqual(['1.log', '2.log']);
  });

  it(`returns the original with ${RAW_ENV}=1 and counts it bypassed`, async () => {
    const output = tapOutput(50);
    writeFileSync(join(dir, 'expected.txt'), output);
    const demo = script('demo.sh', `cat "${join(dir, 'expected.txt')}"`);

    const code = await runFilter([demo], {
      ...deps,
      env: { ...deps.env, [RAW_ENV]: '1' },
    });

    expect(code).toBe(0);
    expect(printed()).toBe(output);
    expect(rawFiles()).toEqual([]);
    expect(stats()[0]?.row).toMatchObject({
      filter: 'fixture/demo',
      rawBytes: Buffer.byteLength(output),
      keptBytes: Buffer.byteLength(output),
      bypassed: true,
      passedThrough: false,
    });
  });

  it('passes an uncovered command through unchanged, stdout and stderr apart', async () => {
    const code = await runFilter(
      ['sh', '-c', 'echo out; echo err >&2; exit 4'],
      deps,
    );
    expect(code).toBe(4);
    const of = (stream: 'out' | 'err') =>
      out
        .filter((o) => o.stream === stream)
        .map((o) => o.text)
        .join('');
    expect(of('out')).toBe('out\n');
    expect(of('err')).toBe('err\n');
    expect(stats()[0]?.row).toMatchObject({
      filter: 'none:uncovered',
      rawBytes: 8,
      keptBytes: 8,
      passedThrough: true,
    });
  });

  it.each([
    ['drops a protected line', 'lossy', 'fixture/lossy'],
    ['throws', 'throws', 'fixture/throws'],
  ])('returns the original when the filter %s', async (_, name, id) => {
    const output = tapOutput(100, FAILURES);
    writeFileSync(join(dir, 'expected.txt'), output);
    const cmd = script(name, `cat "${join(dir, 'expected.txt')}"\nexit 2`);

    expect(await runFilter([cmd], deps)).toBe(2);
    expect(printed()).toBe(output);
    expect(stats()[0]?.row).toMatchObject({ filter: id, passedThrough: true });
  });

  it('returns the original when the filter cannot classify the output', async () => {
    const demo = script('demo.sh', 'echo demo-test 4.2.0');
    await runFilter([demo], deps);
    expect(printed()).toBe('demo-test 4.2.0\n');
    expect(stats()[0]?.row.passedThrough).toBe(true);
  });

  it('stays out of the way without the launch env: no stats, no raw files', async () => {
    const demo = script('demo.sh', `printf 'ok 1 - a\\nok 2 - b\\n'`);
    const code = await runFilter([demo], {
      ...deps,
      env: { PATH: process.env.PATH },
    });
    expect(code).toBe(0);
    expect(printed()).toBe('ok 1 - a\nok 2 - b\n');
    expect(stats()).toEqual([]);
    expect(rawFiles()).toEqual([]);
  });

  it('exits 127 for a command that does not exist', async () => {
    expect(await runFilter(['/no/such/command'], deps)).toBe(127);
    const err = out.find((o) => o.stream === 'err')?.text;
    expect(err).toContain('command not found');
    expect(stats()[0]?.row.passedThrough).toBe(true);
  });

  it('forwards a signal and exits as a shell would', async () => {
    let forward: ((s: NodeJS.Signals) => void) | null = null;
    const sleeper = script('demo.sh', 'exec sleep 10');
    const running = runFilter([sleeper], {
      ...deps,
      onSignal: (handler) => {
        forward = handler;
        return () => {};
      },
    });
    await Bun.sleep(100);
    (forward as ((s: NodeJS.Signals) => void) | null)?.('SIGTERM');
    expect(await running).toBe(143);
  });

  it('streams an output too big to hold, and caps the raw file with a marker', async () => {
    const size = RAW_CAP_BYTES + 1024 * 1024;
    const big = script('demo.sh', `head -c ${size} /dev/zero | tr '\\0' 'a'`);
    const code = await runFilter([big], deps);
    expect(code).toBe(0);
    expect(out.reduce((n, o) => n + o.text.length, 0)).toBe(size);
    const raw = readFileSync(join(dir, 'raw', '1.log'), 'utf8');
    expect(raw.length).toBe(RAW_CAP_BYTES + RAW_TRUNCATED_MARKER.length);
    expect(raw.endsWith(RAW_TRUNCATED_MARKER)).toBe(true);
    expect(stats()[0]?.row).toMatchObject({
      rawBytes: size,
      keptBytes: size,
      passedThrough: true,
    });
  });
});

describe('judge (D4b)', () => {
  const footer = () => '[footer]\n';

  it('refuses a result that is not shorter, footer included', () => {
    const verdict = judge(demoFilter, ['demo-test'], 'ok 1 - a\n', 0, footer);
    expect(verdict.kind).toBe('original');
  });

  it('says how many lines it hid, into the footer', () => {
    let hidden = -1;
    const verdict = judge(demoFilter, ['demo-test'], tapOutput(30), 0, (n) => {
      hidden = n;
      return `[${n} hidden]\n`;
    });
    expect(verdict.kind).toBe('filtered');
    expect(hidden).toBe(30);
  });
});

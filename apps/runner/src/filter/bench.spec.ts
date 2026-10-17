import { afterAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { filterEnv } from './env';

/**
 * The overhead ceiling (#445 D3): `filter` may add at most 50 ms per command
 * at the 95th percentile. Measured as each run of `<runner> filter -- true`
 * minus a run of `true` right before it, through `main.ts` the way an agent's
 * shell starts it — with the launch env set, so the raw file and the stats
 * row are written too. CI runs the tests before the compiled build, so this
 * measures the bun entry; the compiled binary starts faster (see the guide).
 *
 * Wall-clock time is not deterministic on a shared CI host (one run took 1965
 * ms with two pipelines at once), so the benchmark only runs when
 * `RUN_BENCH=1` is set: `RUN_BENCH=1 bun test src/filter/bench.spec.ts`.
 */

export const OVERHEAD_P95_MS = 50;
const RUNS = 40;
const WARMUP = 3;

const percentile = (values: readonly number[], p: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.min(sorted.length - 1, index)] ?? Number.NaN;
};

const time = (
  cmd: string[],
  env: Record<string, string | undefined>,
): number => {
  const start = performance.now();
  const result = Bun.spawnSync(cmd, {
    env,
    stdout: 'ignore',
    stderr: 'ignore',
  });
  const elapsed = performance.now() - start;
  if (result.exitCode !== 0) {
    throw new Error(`${cmd.join(' ')} exited ${result.exitCode}`);
  }
  return elapsed;
};

const benchEnabled = process.env.RUN_BENCH === '1';

describe.skipIf(!benchEnabled)('filter overhead (#445 D3)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bench-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it(`adds at most ${OVERHEAD_P95_MS} ms per command at p95`, () => {
    const env = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      ...filterEnv({
        runDir: dir,
        projectId: 'p1',
        runId: 'r1',
        runKind: 'card',
      }),
    };
    const main = join(import.meta.dir, '..', 'main.ts');
    const filtered = [process.execPath, main, 'filter', '--', 'true'];
    const plain = ['true'];
    for (let i = 0; i < WARMUP; i++) time(filtered, env);
    const overheads: number[] = [];
    for (let i = 0; i < RUNS; i++) {
      const base = time(plain, env);
      overheads.push(time(filtered, env) - base);
    }
    const p50 = percentile(overheads, 50);
    const p95 = percentile(overheads, 95);
    console.info(
      `filter overhead: p50 ${p50.toFixed(1)} ms, p95 ${p95.toFixed(1)} ms (${RUNS} runs)`,
    );
    expect(p95).toBeLessThanOrEqual(OVERHEAD_P95_MS);
  }, 60_000);
});

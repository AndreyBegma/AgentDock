import { afterAll, describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { tempDir } from './testing/fixtures';
import { RUNNER_VERSION } from './version';

describe('compiled binary', () => {
  const { dir, cleanup } = tempDir();
  afterAll(cleanup);

  it('`bun build --compile` produces an agentdock-runner that prints its version', async () => {
    const outfile = join(dir, 'agentdock-runner');
    const build = Bun.spawnSync(
      [
        process.execPath,
        'build',
        '--compile',
        join(import.meta.dir, 'main.ts'),
        '--outfile',
        outfile,
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    expect(build.exitCode).toBe(0);

    const run = Bun.spawnSync([outfile, 'version'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(run.exitCode).toBe(0);
    expect(run.stdout.toString()).toBe(`${RUNNER_VERSION}\n`);
  }, 60_000);
});

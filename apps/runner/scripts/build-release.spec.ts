import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const script = join(import.meta.dir, 'build-release.sh');
const { version } = JSON.parse(
  readFileSync(join(import.meta.dir, '..', 'package.json'), 'utf8'),
) as { version: string };

// Both refusals come before anything is built, so these runs are quick.
const run = (env: Record<string, string>) => {
  const { RUNNER_SIGNING_KEY: _key, RUNNER_TAG: _tag, ...rest } = process.env;
  return Bun.spawnSync(['sh', script], {
    env: { ...rest, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
};

describe('build-release.sh', () => {
  it('fails a tag run without the signing key', () => {
    const result = run({ RUNNER_TAG: `runner-v${version}` });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain(
      'RUNNER_SIGNING_KEY is not set; a tag run must sign SHA256SUMS',
    );
  });

  it('fails a tag run whose tag is not the package version', () => {
    const result = run({
      RUNNER_TAG: 'runner-v0.0.0-not-this',
      RUNNER_SIGNING_KEY: 'unused',
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain(`expected runner-v${version}`);
  });
});

import { afterAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TERMINAL_CLOSE_AS_SUCCESS } from '../src/service';

const script = join(import.meta.dir, 'render-formula.sh');
const fixture = join(
  import.meta.dir,
  '..',
  'homebrew',
  'fixtures',
  'SHA256SUMS',
);

const render = (version: string, sums: string) =>
  Bun.spawnSync(['sh', script, version, sums], {
    stdout: 'pipe',
    stderr: 'pipe',
  });

describe('render-formula.sh', () => {
  const run = render('9.8.7', fixture);
  const formula = run.stdout.toString();

  it('renders every target with its release URL and checksum', () => {
    expect(run.exitCode).toBe(0);
    const expected = {
      'darwin-arm64': '1'.repeat(64),
      'darwin-x64': '2'.repeat(64),
      'linux-x64': '3'.repeat(64),
      'linux-arm64': '4'.repeat(64),
    };
    for (const [target, sha] of Object.entries(expected)) {
      const url = `https://github.com/AndreyBegma/AgentDock/releases/download/runner-v9.8.7/agentdock-runner-9.8.7-${target}.tar.gz`;
      expect(formula).toContain(`url "${url}"\n      sha256 "${sha}"`);
    }
    expect(formula).toContain('version "9.8.7"');
    expect(formula).not.toMatch(/@[A-Z0-9_]+@/);
  });

  it('runs the service through the same exit-78 wrapper as the launchd agent', () => {
    expect(formula).toContain(`'${TERMINAL_CLOSE_AS_SUCCESS}'`);
    expect(formula).toContain('keep_alive successful_exit: false');
  });

  describe('with a target missing from SHA256SUMS', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentdock-formula-'));
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    it('fails and names the tarball', () => {
      const partial = join(dir, 'SHA256SUMS');
      writeFileSync(
        partial,
        readFileSync(fixture, 'utf8')
          .split('\n')
          .filter((line) => !line.includes('linux-x64'))
          .join('\n'),
      );
      const failed = render('9.8.7', partial);
      expect(failed.exitCode).not.toBe(0);
      expect(failed.stderr.toString()).toContain(
        'agentdock-runner-9.8.7-linux-x64.tar.gz',
      );
    });
  });
});

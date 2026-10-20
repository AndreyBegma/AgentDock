import { afterAll, describe, expect, it } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import legacy from './agentdock-runner.js';

// ADR-0073: the deprecated agentdock-runner package runs nautelle-runner.
describe('the agentdock-runner shim', () => {
  it('prints the notice on a terminal only', () => {
    expect(legacy.shouldNotify({ isTTY: true })).toBe(true);
    expect(legacy.shouldNotify({ isTTY: false })).toBe(false);
    expect(legacy.shouldNotify({})).toBe(false);
    expect(legacy.NOTICE).toContain('npm i -g nautelle-runner');
  });

  describe('installed, under node', () => {
    const root = mkdtempSync(join(tmpdir(), 'nautelle-legacy-shim-'));
    afterAll(() => rmSync(root, { recursive: true, force: true }));

    const modules = join(root, 'node_modules');
    const shimPath = join(
      modules,
      'agentdock-runner',
      'bin',
      'agentdock-runner.js',
    );
    mkdirSync(dirname(shimPath), { recursive: true });
    writeFileSync(
      shimPath,
      readFileSync(join(import.meta.dir, 'agentdock-runner.js'), 'utf8'),
    );
    // nautelle-runner's shim, standing in: it echoes the arguments it runs.
    const target = join(
      modules,
      'nautelle-runner',
      'bin',
      'nautelle-runner.js',
    );
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(
      target,
      "module.exports = { main: () => { process.stdout.write(process.argv.slice(2).join('|')); process.exit(7); } };\n",
    );

    it('runs nautelle-runner with the same arguments and exit code, silently off a terminal', () => {
      const run = Bun.spawnSync(['node', shimPath, 'hook', 'stop'], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect(run.stdout.toString()).toBe('hook|stop');
      expect(run.stderr.toString()).toBe('');
      expect(run.exitCode).toBe(7);
    });
  });
});

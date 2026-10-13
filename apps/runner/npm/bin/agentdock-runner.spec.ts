import { afterAll, describe, expect, it } from 'bun:test';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import shim from './agentdock-runner.js';

const found = (path: string) => `/node_modules/${path}`;
const missing = (path: string): string => {
  throw new Error(`Cannot find module '${path}'`);
};

describe('the npm shim', () => {
  it('maps each supported platform to its package', () => {
    expect(shim.platformPackage('darwin', 'arm64')).toBe(
      'agentdock-runner-darwin-arm64',
    );
    expect(shim.platformPackage('darwin', 'x64')).toBe(
      'agentdock-runner-darwin-x64',
    );
    expect(shim.platformPackage('linux', 'x64')).toBe(
      'agentdock-runner-linux-x64',
    );
    expect(shim.platformPackage('linux', 'arm64')).toBe(
      'agentdock-runner-linux-arm64',
    );
  });

  it('has no package for an unsupported platform', () => {
    expect(shim.platformPackage('win32', 'x64')).toBeNull();
    expect(shim.platformPackage('linux', 'ia32')).toBeNull();
    expect(shim.resolveBinary('win32', 'x64', found)).toBeNull();
  });

  it('resolves the binary inside the platform package', () => {
    expect(shim.resolveBinary('linux', 'x64', found)).toBe(
      '/node_modules/agentdock-runner-linux-x64/bin/agentdock-runner',
    );
  });

  it('returns null when the platform package was not installed', () => {
    expect(shim.resolveBinary('darwin', 'arm64', missing)).toBeNull();
  });

  it('on no match, lists the supported targets and the alternatives', () => {
    const message = shim.noMatchMessage('win32', 'x64');
    expect(message).toContain('no prebuilt binary for win32-x64');
    for (const target of shim.TARGETS) expect(message).toContain(target);
    expect(message).toContain('brew install andreybegma/tap/agentdock-runner');
    expect(message).toContain('build from source');
  });

  it('on a supported platform without its package, says optional dependencies were skipped', () => {
    expect(shim.noMatchMessage('linux', 'arm64')).toContain(
      'agentdock-runner-linux-arm64 is not installed',
    );
  });

  it('passes the exit code through, and a signal as 128 + its number', () => {
    expect(shim.exitCodeOf({ status: 78 })).toBe(78);
    expect(shim.exitCodeOf({ status: null, signal: 'SIGTERM' })).toBe(143);
    expect(shim.exitCodeOf({ status: null, signal: null })).toBe(1);
  });

  describe('installed, under node', () => {
    const root = mkdtempSync(join(tmpdir(), 'agentdock-shim-'));
    afterAll(() => rmSync(root, { recursive: true, force: true }));

    const modules = join(root, 'node_modules');
    const shimPath = join(
      modules,
      'agentdock-runner',
      'bin',
      'agentdock-runner.js',
    );
    mkdirSync(dirname(shimPath), { recursive: true });
    copyFileSync(join(import.meta.dir, 'agentdock-runner.js'), shimPath);
    const target = `${process.platform}-${process.arch}`;
    const binary = join(
      modules,
      `agentdock-runner-${target}`,
      'bin',
      'agentdock-runner',
    );

    const runShim = () =>
      Bun.spawnSync(['node', shimPath, 'a', 'b c'], {
        stdout: 'pipe',
        stderr: 'pipe',
      });

    it('without the platform package, prints the no-match message and exits 1', () => {
      const run = runShim();
      expect(run.exitCode).toBe(1);
      expect(run.stderr.toString()).toContain('Supported targets:');
    });

    it('runs the platform binary with the arguments and passes its exit code through', () => {
      mkdirSync(dirname(binary), { recursive: true });
      writeFileSync(binary, '#!/bin/sh\nprintf "%s|" "$@"\nexit 78\n', {
        mode: 0o755,
      });
      const run = runShim();
      expect(run.stdout.toString()).toBe('a|b c|');
      expect(run.exitCode).toBe(78);
    });
  });
});

import { afterAll, describe, expect, it } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TARGETS, writeNpmPackages } from './npm-packages';

describe('npm packages of a release', () => {
  const release = mkdtempSync(join(tmpdir(), 'nautelle-release-'));
  afterAll(() => rmSync(release, { recursive: true, force: true }));

  for (const target of TARGETS) {
    mkdirSync(join(release, 'bin', target), { recursive: true });
    writeFileSync(
      join(release, 'bin', target, 'nautelle-runner'),
      `binary ${target}`,
    );
  }
  writeFileSync(join(release, 'SHA256SUMS'), 'the sums\n');
  writeFileSync(join(release, 'SHA256SUMS.sig'), 'the signature');
  const dirs = writeNpmPackages(release, '1.2.3');
  const manifest = (name: string) =>
    JSON.parse(
      readFileSync(join(release, 'npm', name, 'package.json'), 'utf8'),
    ) as Record<string, unknown>;

  it('writes the four platform packages, the wrapper, then the deprecated package', () => {
    expect(dirs.map((dir) => dir.split('/').pop())).toEqual([
      'nautelle-runner-darwin-arm64',
      'nautelle-runner-darwin-x64',
      'nautelle-runner-linux-arm64',
      'nautelle-runner-linux-x64',
      'nautelle-runner',
      'agentdock-runner',
    ]);
  });

  it('gives each platform package its os, cpu, version and executable binary', () => {
    for (const target of TARGETS) {
      const [os, cpu] = target.split('-');
      const name = `nautelle-runner-${target}`;
      expect(manifest(name)).toMatchObject({
        name,
        version: '1.2.3',
        os: [os],
        cpu: [cpu],
        files: ['bin/nautelle-runner'],
      });
      const binary = join(release, 'npm', name, 'bin', 'nautelle-runner');
      expect(readFileSync(binary, 'utf8')).toBe(`binary ${target}`);
      expect(statSync(binary).mode & 0o777).toBe(0o755);
    }
  });

  it('pins every platform package in the wrapper at the same exact version', () => {
    const wrapper = manifest('nautelle-runner');
    expect(wrapper.version).toBe('1.2.3');
    expect(wrapper.optionalDependencies).toEqual({
      'nautelle-runner-darwin-arm64': '1.2.3',
      'nautelle-runner-darwin-x64': '1.2.3',
      'nautelle-runner-linux-arm64': '1.2.3',
      'nautelle-runner-linux-x64': '1.2.3',
    });
    expect(wrapper.bin).toEqual({
      'nautelle-runner': 'bin/nautelle-runner.js',
    });
    expect(wrapper).not.toHaveProperty('scripts');
  });

  it('ships SHA256SUMS and its signature in the wrapper, for the shim to check', () => {
    const wrapper = join(release, 'npm', 'nautelle-runner');
    expect(readFileSync(join(wrapper, 'SHA256SUMS'), 'utf8')).toBe(
      'the sums\n',
    );
    expect(readFileSync(join(wrapper, 'SHA256SUMS.sig'), 'utf8')).toBe(
      'the signature',
    );
    expect(manifest('nautelle-runner').files).toEqual(
      expect.arrayContaining(['SHA256SUMS', 'SHA256SUMS.sig']),
    );
  });

  // ADR-0073: `npm i -g agentdock-runner` installs the new runner and keeps
  // the old command.
  it('makes agentdock-runner depend on nautelle-runner at the same version', () => {
    const legacy = manifest('agentdock-runner');
    expect(legacy).toMatchObject({
      name: 'agentdock-runner',
      version: '1.2.3',
      dependencies: { 'nautelle-runner': '1.2.3' },
      bin: { 'agentdock-runner': 'bin/agentdock-runner.js' },
    });
    expect(legacy).not.toHaveProperty('optionalDependencies');
    expect(legacy).not.toHaveProperty('scripts');
    const shim = join(
      release,
      'npm',
      'agentdock-runner',
      'bin',
      'agentdock-runner.js',
    );
    expect(readFileSync(shim, 'utf8')).toContain(
      "require('nautelle-runner/bin/nautelle-runner.js').main()",
    );
    expect(statSync(shim).mode & 0o777).toBe(0o755);
  });
});

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
  const release = mkdtempSync(join(tmpdir(), 'agentdock-release-'));
  afterAll(() => rmSync(release, { recursive: true, force: true }));

  for (const target of TARGETS) {
    mkdirSync(join(release, 'bin', target), { recursive: true });
    writeFileSync(
      join(release, 'bin', target, 'agentdock-runner'),
      `binary ${target}`,
    );
  }
  const dirs = writeNpmPackages(release, '1.2.3');
  const manifest = (name: string) =>
    JSON.parse(
      readFileSync(join(release, 'npm', name, 'package.json'), 'utf8'),
    ) as Record<string, unknown>;

  it('writes the four platform packages before the wrapper', () => {
    expect(dirs.map((dir) => dir.split('/').pop())).toEqual([
      'agentdock-runner-darwin-arm64',
      'agentdock-runner-darwin-x64',
      'agentdock-runner-linux-arm64',
      'agentdock-runner-linux-x64',
      'agentdock-runner',
    ]);
  });

  it('gives each platform package its os, cpu, version and executable binary', () => {
    for (const target of TARGETS) {
      const [os, cpu] = target.split('-');
      const name = `agentdock-runner-${target}`;
      expect(manifest(name)).toMatchObject({
        name,
        version: '1.2.3',
        os: [os],
        cpu: [cpu],
        files: ['bin/agentdock-runner'],
      });
      const binary = join(release, 'npm', name, 'bin', 'agentdock-runner');
      expect(readFileSync(binary, 'utf8')).toBe(`binary ${target}`);
      expect(statSync(binary).mode & 0o777).toBe(0o755);
    }
  });

  it('pins every platform package in the wrapper at the same exact version', () => {
    const wrapper = manifest('agentdock-runner');
    expect(wrapper.version).toBe('1.2.3');
    expect(wrapper.optionalDependencies).toEqual({
      'agentdock-runner-darwin-arm64': '1.2.3',
      'agentdock-runner-darwin-x64': '1.2.3',
      'agentdock-runner-linux-arm64': '1.2.3',
      'agentdock-runner-linux-x64': '1.2.3',
    });
    expect(wrapper.bin).toEqual({
      'agentdock-runner': 'bin/agentdock-runner.js',
    });
    expect(wrapper).not.toHaveProperty('scripts');
  });
});

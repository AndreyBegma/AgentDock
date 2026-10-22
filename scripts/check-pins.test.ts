import { describe, expect, test } from 'bun:test';
import { checkManifest } from './check-pins';

const manifest = (deps: Record<string, string>, section = 'dependencies') =>
  JSON.stringify({ name: 'pkg', [section]: deps });

describe('checkManifest', () => {
  test('passes exact versions and workspace references', () => {
    const source = manifest({
      '@nestjs/common': '11.2.7',
      next: '16.0.0-canary.3',
      tool: '1.0.0+build.5',
      '@nautelle/shared': 'workspace:*',
    });
    expect(checkManifest(source)).toEqual([]);
  });

  test.each([
    '^11.1.0',
    '~4.0.0',
    '*',
    'latest',
    '>=1.0.0',
    '1.x',
    '1.2',
    '1.0.0 || 2.0.0',
  ])('fails `%s`', (spec) => {
    expect(checkManifest(manifest({ dep: spec }))).toHaveLength(1);
  });

  test('checks every dependency section', () => {
    for (const section of [
      'devDependencies',
      'peerDependencies',
      'optionalDependencies',
      'overrides',
    ]) {
      expect(checkManifest(manifest({ dep: '^1.0.0' }, section))).toHaveLength(
        1,
      );
    }
  });

  test('ignores fields that are not dependencies', () => {
    const source = JSON.stringify({
      engines: { node: '>=24' },
      scripts: { test: 'bun test' },
    });
    expect(checkManifest(source)).toEqual([]);
  });
});

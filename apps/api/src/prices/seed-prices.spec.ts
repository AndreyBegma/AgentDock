import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { findApiRoot, LANGFUSE_SNAPSHOT_PATH } from './seed-prices';

describe('LANGFUSE_SNAPSHOT_PATH', () => {
  it('points at the vendored snapshot under the API root', () => {
    expect(LANGFUSE_SNAPSHOT_PATH).toBe(
      resolve(__dirname, '../../prisma/seed-data/langfuse-model-prices.json'),
    );
    expect(existsSync(LANGFUSE_SNAPSHOT_PATH)).toBe(true);
  });
});

describe('findApiRoot', () => {
  // The image runs the compiled seed from dist/src/prices (C-172): a fixed
  // `../..` resolved to dist/prisma, which does not exist.
  it('finds the package root from the source and the compiled layout', () => {
    const root = mkdtempSync(join(tmpdir(), 'api-root-'));
    writeFileSync(join(root, 'package.json'), '{}');
    for (const dir of ['src/prices', 'dist/src/prices']) {
      mkdirSync(join(root, dir), { recursive: true });
      expect(findApiRoot(join(root, dir))).toBe(root);
    }
  });
});

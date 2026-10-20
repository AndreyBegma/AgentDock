import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renameInTap } from './tap-rename';

describe('tap-rename (ADR-0073)', () => {
  let tap = '';
  beforeEach(() => {
    tap = mkdtempSync(join(tmpdir(), 'nautelle-tap-'));
    mkdirSync(join(tap, 'Formula'));
  });
  afterEach(() => rmSync(tap, { recursive: true, force: true }));

  const renames = () =>
    JSON.parse(readFileSync(join(tap, 'formula_renames.json'), 'utf8'));

  it('removes the old formula and records the rename', () => {
    writeFileSync(join(tap, 'Formula', 'agentdock-runner.rb'), 'old');
    writeFileSync(join(tap, 'Formula', 'nautelle-runner.rb'), 'new');
    renameInTap(tap);
    expect(existsSync(join(tap, 'Formula', 'agentdock-runner.rb'))).toBe(false);
    expect(existsSync(join(tap, 'Formula', 'nautelle-runner.rb'))).toBe(true);
    expect(renames()).toEqual({ 'agentdock-runner': 'nautelle-runner' });
  });

  it('keeps the other renames and is idempotent', () => {
    writeFileSync(
      join(tap, 'formula_renames.json'),
      JSON.stringify({ 'old-tool': 'tool' }),
    );
    renameInTap(tap);
    renameInTap(tap);
    expect(renames()).toEqual({
      'old-tool': 'tool',
      'agentdock-runner': 'nautelle-runner',
    });
  });
});

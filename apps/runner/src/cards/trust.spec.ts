import { describe, expect, it } from 'bun:test';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ConfigProfile } from '../config';
import { tempDir } from '../testing/fixtures';
import { trustWorktree } from './trust';

const profileIn = (dir: string): ConfigProfile => ({
  id: 'claude-work',
  runtime: 'claude',
  env: { CLAUDE_CONFIG_DIR: dir },
  args: [],
});

const read = (dir: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(dir, '.claude.json'), 'utf8'));

const withDir = (fn: (dir: string) => void): void => {
  const { dir, cleanup } = tempDir();
  try {
    fn(dir);
  } finally {
    cleanup();
  }
};

describe('trustWorktree (#624)', () => {
  it('marks the worktree trusted and keeps every other key', () =>
    withDir((dir) => {
      const worktree = join(dir, 'wt');
      mkdirSync(worktree);
      writeFileSync(
        join(dir, '.claude.json'),
        JSON.stringify({
          numStartups: 7,
          mcpServers: { a: { command: 'x' } },
          projects: {
            '/elsewhere': { hasTrustDialogAccepted: false, allowedTools: [] },
            [worktree]: { lastSessionId: 's1' },
          },
        }),
      );
      expect(trustWorktree(profileIn(dir), dir, worktree)).toBe(true);
      expect(read(dir)).toEqual({
        numStartups: 7,
        mcpServers: { a: { command: 'x' } },
        projects: {
          '/elsewhere': { hasTrustDialogAccepted: false, allowedTools: [] },
          [worktree]: { lastSessionId: 's1', hasTrustDialogAccepted: true },
        },
      });
    }));

  it('creates the file when the profile has none yet', () =>
    withDir((dir) => {
      const worktree = join(dir, 'wt');
      mkdirSync(worktree);
      expect(trustWorktree(profileIn(dir), dir, worktree)).toBe(true);
      expect(read(dir)).toEqual({
        projects: { [worktree]: { hasTrustDialogAccepted: true } },
      });
    }));

  it('trusts the real path of a worktree reached through a symlink', () =>
    withDir((dir) => {
      const real = join(dir, 'real');
      mkdirSync(real);
      const link = join(dir, 'link');
      symlinkSync(real, link);
      expect(trustWorktree(profileIn(dir), dir, link)).toBe(true);
      expect(read(dir).projects).toEqual({
        [real]: { hasTrustDialogAccepted: true },
        [link]: { hasTrustDialogAccepted: true },
      });
    }));

  it('leaves an unreadable file alone', () =>
    withDir((dir) => {
      writeFileSync(join(dir, '.claude.json'), '{ not json');
      expect(trustWorktree(profileIn(dir), dir, join(dir, 'wt'))).toBe(false);
      expect(readFileSync(join(dir, '.claude.json'), 'utf8')).toBe(
        '{ not json',
      );
      writeFileSync(join(dir, '.claude.json'), '[]');
      expect(trustWorktree(profileIn(dir), dir, join(dir, 'wt'))).toBe(false);
    }));

  it('uses ~/.claude.json for a profile without CLAUDE_CONFIG_DIR', () =>
    withDir((dir) => {
      const worktree = join(dir, 'wt');
      mkdirSync(worktree);
      const profile: ConfigProfile = { ...profileIn(dir), env: {} };
      expect(trustWorktree(profile, dir, worktree)).toBe(true);
      expect(read(dir).projects).toEqual({
        [worktree]: { hasTrustDialogAccepted: true },
      });
    }));
});

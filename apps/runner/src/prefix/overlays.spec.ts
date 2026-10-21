import { afterEach, describe, expect, it } from 'bun:test';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { CardPrefix } from '@nautelle/shared';
import { tempDir } from '../testing/fixtures';
import { sha256Hex } from './measure';
import {
  applyCardPrefix,
  OVERLAY_CLAUDE_MD_FILE,
  OVERLAY_PLUGIN,
  OVERLAY_PLUGIN_DIR,
  overlayOriginalPath,
} from './overlays';

let cleanups: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanups.reverse()) fn();
  cleanups = [];
});

const write = (path: string, text: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

const CLAUDE_MD = '# Project\n\nLong rules.\n';
const SKILL =
  '---\nname: release\ndescription: Cut a release.\n---\nSee references/steps.md';

const setup = () => {
  const { dir, cleanup } = tempDir();
  cleanups.push(cleanup);
  const cwd = join(dir, 'wt');
  const runDir = join(dir, 'round');
  mkdirSync(runDir, { recursive: true });
  write(join(cwd, 'CLAUDE.md'), CLAUDE_MD);
  write(join(cwd, '.claude', 'skills', 'release', 'SKILL.md'), SKILL);
  write(
    join(cwd, '.claude', 'skills', 'release', 'references', 'steps.md'),
    '1.',
  );
  return { cwd, runDir };
};

const prefix = (overrides: Partial<CardPrefix> = {}): CardPrefix => ({
  cardType: 'bug',
  skillsOff: [],
  overlays: [],
  ...overrides,
});

describe('overlayOriginalPath (#751 B8)', () => {
  it('is CLAUDE.md, else .claude/CLAUDE.md, or a project SKILL.md', () => {
    const { cwd } = setup();
    expect(overlayOriginalPath(cwd, 'claude_md')).toBe('CLAUDE.md');
    expect(overlayOriginalPath(cwd, 'skill:release')).toBe(
      '.claude/skills/release/SKILL.md',
    );
    expect(overlayOriginalPath(cwd, 'skill:nope')).toBeNull();
    const { dir, cleanup } = tempDir();
    cleanups.push(cleanup);
    write(join(dir, '.claude', 'CLAUDE.md'), 'x');
    expect(overlayOriginalPath(dir, 'claude_md')).toBe('.claude/CLAUDE.md');
  });
});

describe('applyCardPrefix (#751 B5, B7, B10, B11)', () => {
  it('narrows MCP and hides skills with skillOverrides "off"', () => {
    const { cwd, runDir } = setup();
    const applied = applyCardPrefix(
      prefix({ mcpAllow: ['github'], skillsOff: ['cs-seo'] }),
      cwd,
      runDir,
    );
    expect(applied.mcpAllow).toEqual(['github']);
    expect(applied.settings).toEqual({ skillOverrides: { 'cs-seo': 'off' } });
    expect(applied.args).toEqual([]);
    expect(applied.stale).toEqual([]);
  });

  it('excludes the original CLAUDE.md and appends the overlay', () => {
    const { cwd, runDir } = setup();
    const applied = applyCardPrefix(
      prefix({
        overlays: [
          {
            id: 'ov_1',
            part: 'claude_md',
            originalSha256: sha256Hex(CLAUDE_MD),
            content: '# P\n',
          },
        ],
      }),
      cwd,
      runDir,
    );
    const file = join(runDir, OVERLAY_CLAUDE_MD_FILE);
    expect(applied.settings.claudeMdExcludes).toEqual([join(cwd, 'CLAUDE.md')]);
    expect(applied.args).toEqual(['--append-system-prompt-file', file]);
    expect(readFileSync(file, 'utf8')).toEndWith('\n\n# P\n');
    expect(applied.loaded.claudeMd?.text).toBe('# P\n');
    // The worktree is never written.
    expect(readFileSync(join(cwd, 'CLAUDE.md'), 'utf8')).toBe(CLAUDE_MD);
  });

  it('carries a skill overlay in a generated plugin, the original off', () => {
    const { cwd, runDir } = setup();
    const applied = applyCardPrefix(
      prefix({
        overlays: [
          {
            id: 'ov_2',
            part: 'skill:release',
            originalSha256: sha256Hex(SKILL),
            content: '---\nname: release\ndescription: Release.\n---\nShort.',
          },
        ],
      }),
      cwd,
      runDir,
    );
    const plugin = join(runDir, OVERLAY_PLUGIN_DIR);
    expect(applied.args).toEqual(['--plugin-dir', plugin]);
    expect(applied.settings.skillOverrides).toEqual({ release: 'off' });
    expect(
      JSON.parse(
        readFileSync(join(plugin, '.claude-plugin', 'plugin.json'), 'utf8'),
      ).name,
    ).toBe(OVERLAY_PLUGIN);
    const skillDir = join(plugin, 'skills', 'release');
    expect(readFileSync(join(skillDir, 'SKILL.md'), 'utf8')).toContain(
      'Short.',
    );
    // Its relative references still resolve.
    expect(lstatSync(join(skillDir, 'references')).isSymbolicLink()).toBe(true);
    expect(existsSync(join(skillDir, 'references', 'steps.md'))).toBe(true);
  });

  it('launches with the original when it changed, and reports it stale', () => {
    const { cwd, runDir } = setup();
    const applied = applyCardPrefix(
      prefix({
        overlays: [
          {
            id: 'ov_1',
            part: 'claude_md',
            originalSha256: 'a'.repeat(64),
            content: '# P\n',
          },
          {
            id: 'ov_3',
            part: 'skill:gone',
            originalSha256: 'b'.repeat(64),
            content: 'x',
          },
        ],
      }),
      cwd,
      runDir,
    );
    expect(applied.stale).toEqual([
      { overlayId: 'ov_1', sha256: sha256Hex(CLAUDE_MD) },
      { overlayId: 'ov_3', sha256: sha256Hex('') },
    ]);
    expect(applied.args).toEqual([]);
    expect(applied.settings).toEqual({});
    expect(existsSync(join(runDir, OVERLAY_CLAUDE_MD_FILE))).toBe(false);
  });
});

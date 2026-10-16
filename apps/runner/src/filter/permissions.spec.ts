import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LAUNCH_SETTINGS_ENV } from './env';
import {
  type PermissionRules,
  parseBashRule,
  permissionFor,
  readRules,
  settingsFiles,
} from './permissions';

const rules = (r: Partial<PermissionRules>): PermissionRules => ({
  allow: [],
  deny: [],
  ask: [],
  ...r,
});

interface Row {
  name: string;
  rules: Partial<PermissionRules>;
  mode?: string;
  command: string;
  rewrite: boolean;
}

// biome-ignore format: one row per line reads as the table it is
const table: Row[] = [
  // deny: a matching rule always wins, even in bypass mode
  { name: 'deny prefix', rules: { deny: ['Bash(git push:*)'] }, mode: 'bypassPermissions', command: 'git push origin main', rewrite: false },
  { name: 'deny prefix, generous: no word boundary needed', rules: { deny: ['Bash(git pus:*)'] }, mode: 'bypassPermissions', command: 'git push', rewrite: false },
  { name: 'deny exact also covers longer commands', rules: { deny: ['Bash(git push)'] }, mode: 'bypassPermissions', command: 'git push --force', rewrite: false },
  { name: 'deny glob', rules: { deny: ['Bash(kubectl * delete *)'] }, mode: 'bypassPermissions', command: 'kubectl -n prod delete pod x', rewrite: false },
  { name: 'deny bare Bash', rules: { deny: ['Bash'] }, mode: 'bypassPermissions', command: 'bun test', rewrite: false },
  { name: 'deny on the command behind assignments', rules: { deny: ['Bash(git push:*)'] }, mode: 'bypassPermissions', command: 'GIT_TRACE=1 git push', rewrite: false },
  { name: 'unrelated deny', rules: { deny: ['Bash(git push:*)', 'Read(./.env)'] }, mode: 'bypassPermissions', command: 'bun test', rewrite: true },
  // ask: same as deny — the rewrite must not skip a question
  { name: 'ask prefix', rules: { ask: ['Bash(bun run deploy:*)'], allow: ['Bash(bun run:*)'] }, command: 'bun run deploy', rewrite: false },
  { name: 'ask glob trailing space-star covers the bare command', rules: { ask: ['Bash(terraform apply *)'] }, mode: 'bypassPermissions', command: 'terraform apply', rewrite: false },
  // allow: strict
  { name: 'allow prefix', rules: { allow: ['Bash(bun run test:*)'] }, command: 'bun run test', rewrite: true },
  { name: 'allow prefix with args', rules: { allow: ['Bash(bun run test:*)'] }, command: 'bun run test --coverage', rewrite: true },
  { name: 'allow prefix, strict: needs a word boundary', rules: { allow: ['Bash(bun run test:*)'] }, command: 'bun run testing', rewrite: false },
  { name: 'allow exact', rules: { allow: ['Bash(bun test)'] }, command: 'bun test', rewrite: true },
  { name: 'allow exact, strict: not a longer command', rules: { allow: ['Bash(bun test)'] }, command: 'bun test a.spec.ts', rewrite: false },
  { name: 'allow glob', rules: { allow: ['Bash(git log *)'] }, command: 'git log --oneline', rewrite: true },
  { name: 'allow glob does not cover the bare command', rules: { allow: ['Bash(git log *)'] }, command: 'git log', rewrite: false },
  { name: 'allow bare Bash', rules: { allow: ['Bash'] }, command: 'bun test', rewrite: true },
  { name: 'allow star', rules: { allow: ['Bash(*)'] }, command: 'bun test', rewrite: true },
  { name: 'allow is matched on the command as sent', rules: { allow: ['Bash(bun test:*)'] }, command: 'CI=1 bun test', rewrite: false },
  // bypass mode
  { name: 'bypass with no rules', rules: {}, mode: 'bypassPermissions', command: 'bun test', rewrite: true },
  { name: 'default mode with no rules', rules: {}, mode: 'default', command: 'bun test', rewrite: false },
  { name: 'acceptEdits is not bypass', rules: {}, mode: 'acceptEdits', command: 'bun test', rewrite: false },
  { name: 'no mode given', rules: {}, command: 'bun test', rewrite: false },
  // unknown syntax: doubt means no rewrite
  { name: 'unknown deny syntax', rules: { deny: ['Bash(git push'] }, mode: 'bypassPermissions', command: 'bun test', rewrite: false },
  { name: 'unknown ask syntax', rules: { ask: ['Bash(a:*b:*)'] }, mode: 'bypassPermissions', command: 'bun test', rewrite: false },
  { name: 'non-string rule', rules: { deny: [42] }, mode: 'bypassPermissions', command: 'bun test', rewrite: false },
  { name: 'unknown allow syntax', rules: { allow: ['Bash(bun *test:*)'] }, command: 'bun test', rewrite: false },
  { name: 'other tools are ignored', rules: { allow: ['Read', 'Bash(bun test:*)'], deny: ['WebFetch'] }, command: 'bun test', rewrite: true },
];

describe('permissionFor (#445 hook decision (a))', () => {
  it.each(table)('$name', (row) => {
    const bare = row.command.replace(/^([A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, '');
    const verdict = permissionFor(
      rules(row.rules),
      row.mode,
      row.command,
      bare,
    );
    expect(verdict.rewrite).toBe(row.rewrite);
  });
});

describe('parseBashRule', () => {
  it('reads the shapes Claude Code documents', () => {
    expect(parseBashRule('Bash')).toEqual({ kind: 'all' });
    expect(parseBashRule('Bash(*)')).toEqual({ kind: 'all' });
    expect(parseBashRule('Bash(npm run test:*)')).toEqual({
      kind: 'prefix',
      text: 'npm run test',
    });
    expect(parseBashRule('Bash(npm test)')).toEqual({
      kind: 'exact',
      text: 'npm test',
    });
    expect(parseBashRule('Read(./x)')).toBe('other');
    expect(parseBashRule('BashOutput')).toBe('other');
    expect(parseBashRule('Bash(git push')).toBe('unknown');
  });
});

describe('settings sources', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'perm-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('names the managed, user, project, local and launch files', () => {
    const files = settingsFiles({
      env: {
        CLAUDE_CONFIG_DIR: '/profiles/x',
        [LAUNCH_SETTINGS_ENV]: '/run/settings.json',
      },
      home: '/home/u',
      projectDir: '/repo',
      os: 'linux',
    });
    expect(files).toEqual([
      '/etc/claude-code/managed-settings.json',
      '/profiles/x/settings.json',
      '/repo/.claude/settings.json',
      '/repo/.claude/settings.local.json',
      '/run/settings.json',
    ]);
    expect(
      settingsFiles({
        env: {},
        home: '/home/u',
        projectDir: '/repo',
        os: 'darwin',
      })[1],
    ).toBe('/home/u/.claude/settings.json');
  });

  it('merges the rules of every file that exists', () => {
    mkdirSync(join(dir, '.claude'));
    writeFileSync(
      join(dir, '.claude', 'settings.json'),
      JSON.stringify({ permissions: { allow: ['Bash(bun test:*)'] } }),
    );
    writeFileSync(
      join(dir, 'launch.json'),
      JSON.stringify({
        permissions: { deny: ['Bash(git push:*)'] },
        hooks: {},
      }),
    );
    expect(
      readRules([
        join(dir, 'missing.json'),
        join(dir, '.claude', 'settings.json'),
        join(dir, 'launch.json'),
      ]),
    ).toEqual({
      allow: ['Bash(bun test:*)'],
      deny: ['Bash(git push:*)'],
      ask: [],
    });
  });

  it('doubts a file that exists but does not parse', () => {
    writeFileSync(join(dir, 'bad.json'), '{ not json');
    expect(readRules([join(dir, 'bad.json')])).toBeNull();
    writeFileSync(
      join(dir, 'odd.json'),
      JSON.stringify({ permissions: { deny: 'Bash' } }),
    );
    expect(readRules([join(dir, 'odd.json')])).toBeNull();
  });
});

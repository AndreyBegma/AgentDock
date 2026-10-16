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
import { parseSimpleCommand } from './shell';

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

const BYPASS = 'bypassPermissions';

// biome-ignore format: one row per line reads as the table it is
const table: Row[] = [
  // deny: a matching rule always wins
  { name: 'deny prefix', rules: { deny: ['Bash(git push:*)'] }, mode: BYPASS, command: 'git push origin main', rewrite: false },
  { name: 'deny prefix, generous: no word boundary needed', rules: { deny: ['Bash(git pus:*)'] }, mode: BYPASS, command: 'git push', rewrite: false },
  { name: 'deny exact also covers longer commands', rules: { deny: ['Bash(git push)'] }, mode: BYPASS, command: 'git push --force', rewrite: false },
  { name: 'deny glob', rules: { deny: ['Bash(kubectl * delete *)'] }, mode: BYPASS, command: 'kubectl -n prod delete pod x', rewrite: false },
  { name: 'deny bare Bash', rules: { deny: ['Bash'] }, mode: BYPASS, command: 'bun test', rewrite: false },
  { name: 'deny on the command behind assignments', rules: { deny: ['Bash(git push:*)'] }, mode: BYPASS, command: 'GIT_TRACE=1 git push', rewrite: false },
  { name: 'deny on an assignment itself', rules: { deny: ['Bash(GIT_TRACE=1 git:*)'] }, mode: BYPASS, command: 'GIT_TRACE=1 git status', rewrite: false },
  { name: 'unrelated deny', rules: { deny: ['Bash(git push:*)', 'Read(./.env)'] }, mode: BYPASS, command: 'bun test', rewrite: true },
  // DR-04: whitespace, quotes, directories and position never hide a deny
  { name: 'deny with two spaces in the command', rules: { deny: ['Bash(git push:*)'] }, mode: BYPASS, command: 'git  push', rewrite: false },
  { name: 'deny with a tab in the command', rules: { deny: ['Bash(git push:*)'] }, mode: BYPASS, command: 'git\tpush', rewrite: false },
  { name: 'deny with two spaces in the rule', rules: { deny: ['Bash(git  push:*)'] }, mode: BYPASS, command: 'git push', rewrite: false },
  { name: 'deny with a quoted word', rules: { deny: ['Bash(git push:*)'] }, mode: BYPASS, command: 'git "push"', rewrite: false },
  { name: 'deny with the program by path', rules: { deny: ['Bash(git push:*)'] }, mode: BYPASS, command: '/usr/bin/git push', rewrite: false },
  { name: 'deny later in the command', rules: { deny: ['Bash(rm:*)'] }, mode: BYPASS, command: 'git log rm -rf x', rewrite: false },
  { name: 'deny exact later in the command', rules: { deny: ['Bash(git push)'] }, mode: BYPASS, command: 'make git push', rewrite: false },
  // ask: same as deny — the rewrite must not skip a question
  { name: 'ask prefix', rules: { ask: ['Bash(bun run deploy:*)'] }, mode: BYPASS, command: 'bun run deploy', rewrite: false },
  { name: 'ask glob trailing space-star covers the bare command', rules: { ask: ['Bash(terraform apply *)'] }, mode: BYPASS, command: 'terraform apply', rewrite: false },
  { name: 'ask with extra spaces', rules: { ask: ['Bash(terraform apply *)'] }, mode: BYPASS, command: 'terraform   apply  -auto-approve', rewrite: false },
  // DR-03 (amendments 9, 10): only bypass and auto rewrite, whatever allow says
  { name: 'bypass with no rules', rules: {}, mode: BYPASS, command: 'bun test', rewrite: true },
  { name: 'auto with no rules', rules: {}, mode: 'auto', command: 'bun test', rewrite: true },
  { name: 'auto with a deny', rules: { deny: ['Bash(git push:*)'] }, mode: 'auto', command: 'git  push', rewrite: false },
  { name: 'auto with an ask', rules: { ask: ['Bash(bun run deploy:*)'] }, mode: 'auto', command: 'bun run deploy', rewrite: false },
  { name: 'auto with an unknown deny syntax', rules: { deny: ['Bash(git push'] }, mode: 'auto', command: 'bun test', rewrite: false },
  { name: 'default mode with an allow rule', rules: { allow: ['Bash(bun test:*)'] }, mode: 'default', command: 'bun test', rewrite: false },
  { name: 'acceptEdits with an allow rule', rules: { allow: ['Bash'] }, mode: 'acceptEdits', command: 'bun test', rewrite: false },
  { name: 'plan mode with an allow rule', rules: { allow: ['Bash(*)'] }, mode: 'plan', command: 'bun test', rewrite: false },
  { name: 'dontAsk mode with an allow rule', rules: { allow: ['Bash'] }, mode: 'dontAsk', command: 'bun test', rewrite: false },
  { name: 'an unknown mode', rules: {}, mode: 'Auto', command: 'bun test', rewrite: false },
  { name: 'no mode given', rules: { allow: ['Bash'] }, command: 'bun test', rewrite: false },
  // unknown syntax: doubt means no rewrite
  { name: 'unknown deny syntax', rules: { deny: ['Bash(git push'] }, mode: BYPASS, command: 'bun test', rewrite: false },
  { name: 'unknown ask syntax', rules: { ask: ['Bash(a:*b:*)'] }, mode: BYPASS, command: 'bun test', rewrite: false },
  { name: 'non-string rule', rules: { deny: [42] }, mode: BYPASS, command: 'bun test', rewrite: false },
  { name: 'other tools are ignored', rules: { deny: ['WebFetch', 'Read(./.env)'] }, mode: BYPASS, command: 'bun test', rewrite: true },
];

describe('permissionFor (#445 hook decision (a), amendments 9 and 10)', () => {
  it.each(table)('$name', (row) => {
    const parsed = parseSimpleCommand(row.command);
    if (!parsed) throw new Error(`not simple: ${row.command}`);
    const verdict = permissionFor(
      rules(row.rules),
      row.mode,
      row.command,
      parsed,
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

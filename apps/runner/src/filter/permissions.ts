import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LAUNCH_SETTINGS_ENV } from './env';

/**
 * The hook must never change what a session allows, asks or denies (#445,
 * decision on the hook's permissions). Claude Code matches its permission
 * rules against the command a PreToolUse hook returns, so a rewritten
 * `agentdock-runner filter -- git push` would slip past `Bash(git push:*)`.
 * The hook therefore rewrites only when:
 *
 * - no `deny` or `ask` `Bash(…)` rule matches the original command, and
 * - the session is in `bypassPermissions`, or an `allow` rule already matches
 *   the original command — then the rewrite carries `allow`, which only skips
 *   a prompt the original would not have had.
 *
 * Rules are read best-effort from the files Claude loads; any doubt (a file
 * that exists but does not parse, a rule this parser does not understand)
 * means no rewrite. Deny and ask rules are matched generously, allow rules
 * strictly, so every mismatch errs toward leaving the command alone.
 */

export interface PermissionRules {
  /** As found in settings: a non-string entry is a rule this parser doubts. */
  allow: unknown[];
  deny: unknown[];
  ask: unknown[];
}

export type PermissionVerdict =
  | { rewrite: true }
  | { rewrite: false; reason: string };

/** A rule's Bash pattern: everything, or a match on the command text. */
type Pattern =
  | { kind: 'all' }
  | { kind: 'prefix'; text: string }
  | { kind: 'glob'; regex: RegExp; bare: string | null }
  | { kind: 'exact'; text: string };

/** A rule as written in settings: `Bash`, `Bash(…)`, or another tool's. */
export const parseBashRule = (rule: unknown): Pattern | 'other' | 'unknown' => {
  if (typeof rule !== 'string') return 'unknown';
  const trimmed = rule.trim();
  if (trimmed === 'Bash') return { kind: 'all' };
  if (!trimmed.startsWith('Bash(')) return 'other';
  const match = /^Bash\((.*)\)$/s.exec(trimmed);
  if (!match) return 'unknown';
  const body = (match[1] ?? '').trim();
  if (body === '' || body === '*' || body === ':*') return { kind: 'all' };
  if (body.endsWith(':*')) {
    const text = body.slice(0, -2).trim();
    if (text === '' || text.includes(':*') || text.includes('*')) {
      return 'unknown';
    }
    return { kind: 'prefix', text };
  }
  if (body.includes(':*')) return 'unknown';
  if (body.includes('*')) {
    const source = body
      .split('*')
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*');
    // `Bash(ls *)` also names the bare `ls` for the generous match.
    const bare = body.endsWith(' *') ? body.slice(0, -2).trim() : null;
    return { kind: 'glob', regex: new RegExp(`^${source}$`, 's'), bare };
  }
  return { kind: 'exact', text: body };
};

const startsWord = (command: string, text: string): boolean =>
  command === text || command.startsWith(`${text} `);

/** Deny and ask: when in doubt, it matches. */
const matchesGenerously = (pattern: Pattern, command: string): boolean => {
  switch (pattern.kind) {
    case 'all':
      return true;
    case 'prefix':
      return command.startsWith(pattern.text);
    case 'glob':
      return (
        pattern.regex.test(command) ||
        (pattern.bare !== null && startsWord(command, pattern.bare))
      );
    case 'exact':
      return startsWord(command, pattern.text);
  }
};

/** Allow: only a clear match counts. */
const matchesStrictly = (pattern: Pattern, command: string): boolean => {
  switch (pattern.kind) {
    case 'all':
      return true;
    case 'prefix':
      return startsWord(command, pattern.text);
    case 'glob':
      return pattern.regex.test(command);
    case 'exact':
      return command === pattern.text;
  }
};

/**
 * The verdict for one command. `command` is the original as Claude sent it;
 * `bare` is the same without leading `NAME=value` words, which the deny and
 * ask rules are checked against too.
 */
export const permissionFor = (
  rules: PermissionRules,
  permissionMode: string | undefined,
  command: string,
  bare: string,
): PermissionVerdict => {
  const candidates = [command.trim(), bare.trim()];
  for (const list of ['deny', 'ask'] as const) {
    for (const rule of rules[list]) {
      const pattern = parseBashRule(rule);
      if (pattern === 'other') continue;
      if (pattern === 'unknown') {
        return { rewrite: false, reason: `unparsed ${list} rule` };
      }
      if (candidates.some((c) => matchesGenerously(pattern, c))) {
        return { rewrite: false, reason: `${list} rule` };
      }
    }
  }
  if (permissionMode === 'bypassPermissions') return { rewrite: true };
  for (const rule of rules.allow) {
    const pattern = parseBashRule(rule);
    if (pattern === 'other') continue;
    if (pattern === 'unknown') {
      return { rewrite: false, reason: 'unparsed allow rule' };
    }
    if (matchesStrictly(pattern, command.trim())) return { rewrite: true };
  }
  return { rewrite: false, reason: 'not allowed already' };
};

export interface SettingsSources {
  env: Readonly<Record<string, string | undefined>>;
  home: string;
  /** The session's project directory (`CLAUDE_PROJECT_DIR`, else the hook's cwd). */
  projectDir: string;
  os: string;
}

/** Every settings file Claude Code reads permission rules from, plus the launch's. */
export const settingsFiles = (sources: SettingsSources): string[] => {
  const { env, home, projectDir, os } = sources;
  const configDir = env.CLAUDE_CONFIG_DIR || join(home, '.claude');
  const managed =
    os === 'darwin'
      ? '/Library/Application Support/ClaudeCode/managed-settings.json'
      : '/etc/claude-code/managed-settings.json';
  const files = [
    managed,
    join(configDir, 'settings.json'),
    join(projectDir, '.claude', 'settings.json'),
    join(projectDir, '.claude', 'settings.local.json'),
  ];
  const launch = env[LAUNCH_SETTINGS_ENV];
  if (launch) files.push(launch);
  return files;
};

/**
 * The rules of every file, merged. A file that does not exist adds nothing;
 * one that exists but cannot be read or parsed returns `null` — doubt.
 */
export const readRules = (files: readonly string[]): PermissionRules | null => {
  const rules: PermissionRules = { allow: [], deny: [], ask: [] };
  for (const file of files) {
    if (!existsSync(file)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      return null;
    }
    if (typeof parsed !== 'object' || parsed === null) return null;
    const permissions = (parsed as { permissions?: unknown }).permissions;
    if (permissions === undefined) continue;
    if (typeof permissions !== 'object' || permissions === null) return null;
    for (const list of ['allow', 'deny', 'ask'] as const) {
      const value = (permissions as Record<string, unknown>)[list];
      if (value === undefined) continue;
      if (!Array.isArray(value)) return null;
      rules[list].push(...(value as unknown[]));
    }
  }
  return rules;
};

import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { LAUNCH_SETTINGS_ENV } from './env';
import type { HookCommand } from './shell';

/**
 * The hook must never change what a session allows, asks or denies (#445,
 * decision on the hook's permissions, narrowed by amendment 9, widened to
 * auto mode by amendment 10). Claude Code matches its permission rules
 * against the command a PreToolUse hook returns, so a rewritten
 * `agentdock-runner filter -- git push` would slip past `Bash(git push:*)`.
 * The hook therefore rewrites only when:
 *
 * - the session is in `bypassPermissions`, or in `auto`, where the hook
 *   returns no decision and the classifier judges the wrapped command. In
 *   every other mode Claude Code (its prompt, plan mode) decides and the
 *   command is left as written; and
 * - no `deny` or `ask` `Bash(…)` rule matches the line, at any word of any
 *   of its commands (#610), wrapped or not.
 *
 * Rules are read best-effort from the files Claude loads; any doubt (a file
 * that exists but does not parse, a rule this parser does not understand)
 * means no rewrite. Deny and ask rules are matched generously — on the
 * command's words with whitespace collapsed and quotes dropped, the program
 * with and without its directory, starting at every word — so every mismatch
 * errs toward leaving the command alone.
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
    const text = collapse(body.slice(0, -2));
    if (text === '' || text.includes(':*') || text.includes('*')) {
      return 'unknown';
    }
    return { kind: 'prefix', text };
  }
  if (body.includes(':*')) return 'unknown';
  const text = collapse(body);
  if (text.includes('*')) {
    const source = text
      .split('*')
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*');
    // `Bash(ls *)` also names the bare `ls` for the generous match.
    const bare = text.endsWith(' *') ? text.slice(0, -2).trim() : null;
    return { kind: 'glob', regex: new RegExp(`^${source}$`, 's'), bare };
  }
  return { kind: 'exact', text };
};

/** Runs of whitespace as one space, trimmed. */
const collapse = (text: string): string => text.trim().replace(/\s+/g, ' ');

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

/**
 * Every text a deny or ask rule is tried against: the original with
 * whitespace collapsed, and the parsed words — with and without the
 * assignments, the program with and without its directory — each from every
 * word on, so a rule also meets the command wherever it sits. #610: that for
 * every command of every pipeline, wrapped or not, and for the whole line's
 * words with quotes dropped (amendment 11's `cd <path> && …` is one such
 * line). A rule that matches any command of the line keeps the whole line as
 * written.
 */
export const ruleCandidates = (
  original: string,
  parsed: HookCommand,
): string[] => {
  const forms: string[][] = [];
  const line: string[] = [];
  parsed.pipelines.forEach((pipeline, i) => {
    pipeline.forEach(({ command, mergeStderr }, j) => {
      const { argv, assignments } = command;
      const [program = '', ...args] = argv;
      const withAssignments = [
        ...assignments.map((a) => `${a.name}=${a.value}`),
        ...argv,
      ];
      forms.push(argv, [basename(program), ...args], withAssignments);
      if (j > 0) line.push('|');
      line.push(...withAssignments, ...(mergeStderr ? ['2>&1'] : []));
    });
    const op = parsed.operators[i];
    if (op !== undefined) line.push(op);
  });
  forms.push(line);
  const out = new Set<string>();
  const text = collapse(original);
  const spaces = text.split(' ');
  for (let i = 0; i < spaces.length; i++) out.add(spaces.slice(i).join(' '));
  for (const words of forms) {
    for (let i = 0; i < words.length; i++) {
      out.add(collapse(words.slice(i).join(' ')));
    }
  }
  return [...out].filter((c) => c.length > 0);
};

/**
 * The verdict for one parsed command; `original` is the text Claude sent.
 */
export const permissionFor = (
  rules: PermissionRules,
  permissionMode: string | undefined,
  original: string,
  parsed: HookCommand,
): PermissionVerdict => {
  if (permissionMode !== 'bypassPermissions' && permissionMode !== 'auto') {
    return { rewrite: false, reason: 'not bypassPermissions or auto' };
  }
  const candidates = ruleCandidates(original, parsed);
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
  return { rewrite: true };
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

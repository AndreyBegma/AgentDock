import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  estPrefixTokens,
  PREFIX_PARTS_MAX,
  type PrefixOrigin,
  type PrefixPart,
  type PrefixPartKind,
  RUNNER_MCP_SERVER,
} from '@nautelle/shared';
import { skillNameSchema } from '@nautelle/shared/protocol';
import type { ConfigProfile } from '../config';
import { claudeConfigDir } from '../detect/profiles';
import { SKILL_FILE } from '../skills/discover';
import { parseFrontmatter } from '../skills/frontmatter';
import { pluginSkills, profileSkills } from '../skills/inventory';

/**
 * #751 B1: the launch prefix by part — sizes and hashes only, never the
 * content. Each part is read as Claude Code would load it for this launch;
 * the total of a run's first turn is the fact (B2), these are ≈ estimates.
 * Nothing here throws: a file that cannot be read is a part not reported.
 */

/** The heading `projectRulesBlock` (C-227) opens the injected rules with. */
export const RULES_BLOCK_HEADING = '## Project coding rules';

/**
 * B2: ≈ bytes of one MCP server whose tools are deferred (ADR-0068: the
 * default on a first-party host). Measured on Claude Code 2.1.306: a 45-tool
 * stdio server on a strict MCP config grew the first turn by 885 tokens
 * (26311 → 27196); loaded eagerly it grew it by 37,655. The runner cannot
 * list a server's tools without starting it, so every server is this one
 * estimate; the run's total stays the fact.
 */
export const MCP_DEFERRED_SERVER_BYTES = 885 * 4;

/** B1: a skill's listing line keeps this much of its description. */
export const SKILL_LISTING_DESC_CHARS = 200;

/** `@` imports are followed this deep, as Claude Code does. */
const IMPORT_MAX_DEPTH = 5;
/** A file bigger than this is sized from its metadata, never read. */
const READ_MAX_BYTES = 4 * 1024 * 1024;

const PROJECT_SKILLS_DIR = '.claude/skills';

export const sha256Hex = (data: string | Uint8Array): string =>
  createHash('sha256').update(data).digest('hex');

const utf8Bytes = (text: string): number =>
  new TextEncoder().encode(text).length;

/** A loaded text in place of a file's own (an overlay, B7). */
export interface LoadedText {
  /** The text the launch loads. */
  text: string;
  /** The original's hash, which the row keeps so the API can match it. */
  originalSha256: string;
}

export interface MeasureInput {
  profile: ConfigProfile;
  home: string;
  /** The launch's working directory; without one there are no repo parts. */
  cwd?: string;
  /** The launch's prompt: its rules block, and Nautelle's own part. */
  prompt?: string;
  /** The `--agents` JSON, when the launch passes one. */
  agents?: string;
  /** The MCP servers the launch loads, with their definitions. */
  mcpServers?: Record<string, unknown>;
  /** Skills hidden with `skillOverrides` "off": not listed, not counted. */
  skillsOff?: readonly string[];
  /**
   * B7: what an overlay loads instead of the original — the absolute path of
   * a replaced `CLAUDE.md`, and a replaced project skill by name.
   */
  overlays?: {
    claudeMd?: { path: string } & LoadedText;
    skills?: Record<string, LoadedText>;
  };
}

class Parts {
  readonly list: PrefixPart[] = [];
  private readonly seen = new Set<string>();

  add(
    kind: PrefixPartKind,
    name: string,
    path: string,
    origin: PrefixOrigin,
    bytes: number,
    sha256: string,
  ): void {
    const key = `${kind}\u0000${name}`;
    if (this.seen.has(key) || this.list.length >= PREFIX_PARTS_MAX) return;
    this.seen.add(key);
    this.list.push({
      kind,
      name: name.slice(0, 200),
      path,
      origin,
      bytes,
      estTokens: estPrefixTokens(bytes),
      sha256,
    });
  }
}

const isWithin = (child: string, dir: string): boolean => {
  const rel = relative(dir, child);
  return (
    rel === '' ||
    (!isAbsolute(rel) && !rel.startsWith(`..${sep}`) && rel !== '..')
  );
};

const readSmall = (path: string): Buffer | null => {
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > READ_MAX_BYTES) return null;
    return readFileSync(path);
  } catch {
    return null;
  }
};

/**
 * The text that launches the prompt's rules block (C-227): from its heading
 * to the next `## ` heading, or the end. Null without one.
 */
export const splitRulesBlock = (
  prompt: string,
): { rules: string | null; rest: string } => {
  const at = prompt.startsWith(RULES_BLOCK_HEADING)
    ? 0
    : prompt.indexOf(`\n${RULES_BLOCK_HEADING}`) + 1;
  if (at === 0 && !prompt.startsWith(RULES_BLOCK_HEADING)) {
    return { rules: null, rest: prompt };
  }
  const next = prompt.indexOf('\n## ', at + RULES_BLOCK_HEADING.length);
  const end = next === -1 ? prompt.length : next + 1;
  return {
    rules: prompt.slice(at, end),
    rest: prompt.slice(0, at) + prompt.slice(end),
  };
};

/** The `@path` imports of a memory file, outside code. */
export const memoryImports = (text: string): string[] => {
  const found: string[] = [];
  let fenced = false;
  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const bare = line.replace(/`[^`]*`/g, '');
    for (const match of bare.matchAll(
      /(?:^|\s)@((?:~\/|\.{1,2}\/|\/)?[\w.\-/]+)/g,
    )) {
      const path = match[1];
      if (path && /[./]/.test(path)) found.push(path);
    }
  }
  return found;
};

/**
 * The display path of a file: relative to the launch's cwd, else `~/…`
 * under home; null for any other file, which is not reported.
 */
const displayOf = (
  abs: string,
  cwd: string | undefined,
  home: string,
): { path: string; origin: PrefixOrigin } | null => {
  if (cwd !== undefined && isWithin(abs, cwd)) {
    return { path: relative(cwd, abs), origin: 'repo' };
  }
  if (isWithin(abs, home)) {
    return { path: `~/${relative(home, abs)}`, origin: 'profile' };
  }
  return null;
};

const markdownFiles = (dir: string, depth = 2): string[] => {
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const path = join(dir, entry.name);
    if (entry.isDirectory() && depth > 1) {
      files.push(...markdownFiles(path, depth - 1));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      files.push(path);
    }
  }
  return files;
};

/**
 * B1: the `CLAUDE.md` load chain — the profile's user file and rules, every
 * parent of the cwd under home, the cwd's `CLAUDE.md`, `.claude/CLAUDE.md`,
 * `CLAUDE.local.md` and `.claude/rules`, and the files they import.
 */
const measureMemory = (input: MeasureInput, parts: Parts): void => {
  const { home, cwd } = input;
  const configDir = claudeConfigDir(input.profile, home);
  const chain: string[] = [
    join(configDir, 'CLAUDE.md'),
    ...markdownFiles(join(configDir, 'rules')),
  ];
  if (cwd !== undefined) {
    const parents: string[] = [];
    for (let dir = dirname(cwd); isWithin(dir, home); dir = dirname(dir)) {
      parents.unshift(join(dir, 'CLAUDE.md'), join(dir, 'CLAUDE.local.md'));
      if (dir === home || dirname(dir) === dir) break;
    }
    chain.push(
      ...parents,
      join(cwd, 'CLAUDE.md'),
      join(cwd, '.claude', 'CLAUDE.md'),
      join(cwd, 'CLAUDE.local.md'),
      ...markdownFiles(join(cwd, '.claude', 'rules')),
    );
  }
  const visited = new Set<string>();
  const visit = (abs: string, depth: number): void => {
    if (visited.has(abs)) return;
    visited.add(abs);
    const display = displayOf(abs, cwd, home);
    if (display === null) return;
    const overlay = input.overlays?.claudeMd;
    if (overlay !== undefined && overlay.path === abs) {
      parts.add(
        'claude_md',
        display.path,
        display.path,
        display.origin,
        utf8Bytes(overlay.text),
        overlay.originalSha256,
      );
      return;
    }
    const data = readSmall(abs);
    if (data === null) return;
    parts.add(
      'claude_md',
      display.path,
      display.path,
      display.origin,
      data.length,
      sha256Hex(data),
    );
    if (depth >= IMPORT_MAX_DEPTH) return;
    for (const ref of memoryImports(data.toString('utf8'))) {
      const target = ref.startsWith('~/')
        ? join(home, ref.slice(2))
        : resolve(dirname(abs), ref);
      visit(target, depth + 1);
    }
  };
  for (const abs of chain) visit(abs, 0);
};

/** B1: one skill's listing line, as `skillListingMaxDescChars` cuts it. */
export const skillListingLine = (name: string, description: string): string =>
  `- ${name}: ${description.replace(/\s+/g, ' ').trim().slice(0, SKILL_LISTING_DESC_CHARS)}`;

const describeOf = (text: string): string => {
  const description = parseFrontmatter(text).description;
  return typeof description === 'string' ? description : '';
};

/** B1: one row per listed skill — the cwd's, the profile's, its plugins'. */
const measureSkills = (input: MeasureInput, parts: Parts): void => {
  const off = new Set(input.skillsOff ?? []);
  const replaced = input.overlays?.skills ?? {};
  const add = (
    name: string,
    path: string,
    origin: PrefixOrigin,
    description: string,
    sha256: string,
  ): void => {
    const line = skillListingLine(name, description);
    parts.add('skill', name, path, origin, utf8Bytes(line), sha256);
  };
  if (input.cwd !== undefined) {
    let names: string[] = [];
    try {
      names = readdirSync(join(input.cwd, PROJECT_SKILLS_DIR)).sort();
    } catch {}
    for (const name of names) {
      if (!skillNameSchema.safeParse(name).success) continue;
      const path = `${PROJECT_SKILLS_DIR}/${name}/${SKILL_FILE}`;
      const overlay = replaced[name];
      if (overlay !== undefined) {
        add(
          name,
          path,
          'repo',
          describeOf(overlay.text),
          overlay.originalSha256,
        );
        continue;
      }
      if (off.has(name)) continue;
      const data = readSmall(join(input.cwd, path));
      if (data === null) continue;
      add(
        name,
        path,
        'repo',
        describeOf(data.toString('utf8')),
        sha256Hex(data),
      );
    }
  }
  const installed = [
    ...profileSkills(input.profile, input.home),
    ...pluginSkills(input.profile, input.home),
  ];
  for (const skill of installed) {
    if (off.has(skill.invocation)) continue;
    const file = join(skill.path, SKILL_FILE);
    const display = displayOf(file, undefined, input.home);
    const data = readSmall(file);
    if (data === null) continue;
    add(
      skill.invocation,
      display?.path ?? '',
      skill.scope === 'plugin' ? 'plugin' : 'profile',
      skill.description ?? '',
      sha256Hex(data),
    );
  }
};

/** B2: a server's identity — never its env, which may hold a secret. */
const mcpIdentity = (name: string, definition: unknown): string => {
  const d =
    typeof definition === 'object' && definition !== null
      ? (definition as Record<string, unknown>)
      : {};
  return JSON.stringify([
    name,
    d.type ?? null,
    d.command ?? null,
    d.args ?? null,
    d.url ?? null,
  ]);
};

/** B1: the launch's prefix parts. */
export const measurePrefix = (input: MeasureInput): PrefixPart[] => {
  const parts = new Parts();
  measureMemory(input, parts);
  if (input.prompt !== undefined) {
    const { rules, rest } = splitRulesBlock(input.prompt);
    if (rules !== null) {
      parts.add(
        'rules',
        'rules',
        '',
        'nautelle',
        utf8Bytes(rules),
        sha256Hex(rules),
      );
    }
    parts.add(
      'nautelle',
      'prompt',
      '',
      'nautelle',
      utf8Bytes(rest),
      sha256Hex(rest),
    );
  }
  measureSkills(input, parts);
  for (const [name, definition] of Object.entries(
    input.mcpServers ?? {},
  ).sort()) {
    parts.add(
      'mcp',
      name,
      '',
      name === RUNNER_MCP_SERVER ? 'nautelle' : 'profile',
      MCP_DEFERRED_SERVER_BYTES,
      sha256Hex(mcpIdentity(name, definition)),
    );
  }
  if (input.agents !== undefined) {
    parts.add(
      'agents',
      'agents',
      '',
      'nautelle',
      utf8Bytes(input.agents),
      sha256Hex(input.agents),
    );
  }
  return parts.list;
};

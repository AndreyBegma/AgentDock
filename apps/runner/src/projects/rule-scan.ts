import { join, sep } from 'node:path';
import {
  PROJECT_RULE_DESCRIPTION_MAX,
  PROJECT_RULE_TITLE_MAX,
  ruleTitleKey,
} from '@nautelle/shared';
import {
  type ProjectScanRulesResult,
  RULE_SCAN_CANDIDATES_MAX,
  RULE_SCAN_FILE_MAX_BYTES,
  RULE_SCAN_PER_FILE_MAX,
  type RuleCandidate,
} from '@nautelle/shared/protocol';
import { CommandFailure } from '../commands/failure';
import { isDirectory, nodeFs, type ProjectFs } from './fs';

/** Guides whose list items are read as rules, in this order. */
export const RULE_SCAN_GUIDES = [
  'CLAUDE.md',
  'AGENTS.md',
  'CONTRIBUTING.md',
  '.github/CONTRIBUTING.md',
  'docs/CONTRIBUTING.md',
];

/** Config files mapped to rules by `configCandidates`, in this order. */
export const RULE_SCAN_CONFIGS = [
  'biome.json',
  'biome.jsonc',
  '.eslintrc.json',
  '.eslintrc',
  'eslint.config.js',
  'eslint.config.mjs',
  'eslint.config.cjs',
  'eslint.config.ts',
  '.prettierrc',
  '.prettierrc.json',
  '.editorconfig',
  'tsconfig.json',
];

/** Sections of a guide that describe the repository, not how to write code. */
const SKIPPED_SECTIONS =
  /^(overview|structure|(project|repository|repo|directory|folder) (structure|layout)|layout|commands?|scripts|setup|install(ation)?|getting started|quick ?start|(table of )?contents|license|links|references|see also)$/i;

const LIST_ITEM = /^( {0,3})([-*+]|\d{1,9}[.)])[ \t]+(.*)$/;
const ATX_HEADING = /^ {0,3}#{1,6}[ \t]+(.*?)[ \t#]*$/;
const FENCE = /^ *(`{3,}|~{3,})/;
const TASK_BOX = /^\[[ xX]\]\s/;
/** `**Name**: text`, `**Name** — text`, `**Name.** text`. */
const BOLD_LEAD = /^\*\*(.+?)\*\*(\s*(?:[:—–]|-(?=\s)))?\s*(.*)$/s;
/** A rule's title is short; the full text stays in the description. */
const TITLE_SOFT_MAX = 80;
const MIN_WORDS = 3;

const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;

/** Inline Markdown down to its text: emphasis, code spans, links. */
const plain = (text: string): string =>
  text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|\W)[*_](\S(?:.*?\S)?)[*_](?=\W|$)/g, '$1$2')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();

/** The first clause, cut on a word near `TITLE_SOFT_MAX`. */
const titleOf = (text: string): string => {
  const first = plain(text).split(/(?<=[.;!?])\s|\s[—–]\s|:\s/)[0] ?? '';
  const clause = first.replace(/[.;:!?]+$/, '').trim();
  if (clause.length <= TITLE_SOFT_MAX) return clause;
  const cut = clause.slice(0, TITLE_SOFT_MAX);
  const space = cut.lastIndexOf(' ');
  return `${(space > 40 ? cut.slice(0, space) : cut).trimEnd()}…`;
};

const candidate = (
  title: string,
  description: string,
  source: string,
): RuleCandidate => ({
  title: clip(title.trim(), PROJECT_RULE_TITLE_MAX),
  description: clip(description.trim(), PROJECT_RULE_DESCRIPTION_MAX),
  source,
});

/** One list item of a guide as a rule, or null when it reads as no rule. */
const itemCandidate = (
  lines: readonly string[],
  source: string,
): RuleCandidate | null => {
  const text = lines.join('\n').trim();
  if (TASK_BOX.test(text)) return null;
  const bold = BOLD_LEAD.exec(text);
  const [, lead = '', separator, rest = ''] = bold ?? [];
  if (bold && (separator || /[.:]$/.test(lead)) && rest) {
    const title = plain(lead).replace(/[.:]+$/, '');
    if (title) return candidate(title, rest, source);
  }
  const title = titleOf(text);
  if (title.split(' ').filter(Boolean).length < MIN_WORDS) return null;
  const whole = plain(text).replace(/[.;:!?]+$/, '') === title;
  return candidate(title, whole ? '' : text, source);
};

/**
 * The list items of a guide, one candidate each (#584 "Open questions":
 * deterministic, no model call). Items under a section that describes the
 * repository (`Structure`, `Commands`, …) and anything in fenced code are
 * left out; nested items and continuation lines stay in their item's text.
 */
export const guideCandidates = (
  markdown: string,
  source: string,
): RuleCandidate[] => {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const found: RuleCandidate[] = [];
  let fence: string | null = null;
  let skipped = false;
  let item: string[] | null = null;
  let blank = false;
  const close = () => {
    if (item) {
      const made = itemCandidate(item, source);
      if (made) found.push(made);
    }
    item = null;
  };

  for (const line of lines) {
    const marker = FENCE.exec(line)?.[1];
    if (fence !== null) {
      if (marker?.[0] === fence[0] && marker.length >= fence.length) {
        fence = null;
      }
      if (item && !skipped) item.push(line);
      continue;
    }
    if (marker) {
      fence = marker;
      if (item && line.startsWith(' ')) {
        item.push(line);
        continue;
      }
      close();
      continue;
    }
    const heading = ATX_HEADING.exec(line);
    if (heading) {
      close();
      skipped = SKIPPED_SECTIONS.test(plain(heading[1] ?? ''));
      continue;
    }
    const match = LIST_ITEM.exec(line);
    if (match && (match[1] ?? '').length <= 1) {
      close();
      if (!skipped) item = [match[3] ?? ''];
      blank = false;
      continue;
    }
    if (item === null) continue;
    if (line.trim() === '') {
      blank = true;
      continue;
    }
    const indented = /^\s/.test(line);
    // After a blank line only indented text belongs to the item; before one,
    // a plain line is a lazy continuation.
    if (blank && !indented) {
      close();
      continue;
    }
    if (blank) item.push('');
    blank = false;
    item.push(line.trim());
  }
  close();
  return found.slice(0, RULE_SCAN_PER_FILE_MAX);
};

/** JSON with comments and trailing commas (biome.jsonc, tsconfig.json). */
export const parseJsonc = (text: string): unknown => {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 2;
    } else {
      out += c;
      i++;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
};

type Json = Record<string, unknown>;

const isRecord = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const record = (value: unknown): Json => (isRecord(value) ? value : {});

const listed = (parts: readonly string[]): string =>
  parts.length <= 1
    ? (parts[0] ?? '')
    : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;

const indentPart = (style: unknown, width: unknown): string | null => {
  if (style === 'tab') return 'tab indentation';
  if (typeof width === 'number') return `${width}-space indentation`;
  if (style === 'space') return 'space indentation';
  return null;
};

const biomeCandidates = (json: Json, source: string): RuleCandidate[] => {
  const formatter = record(json.formatter);
  const js = record(record(json.javascript).formatter);
  const found: RuleCandidate[] = [];
  if (formatter.enabled !== false) {
    const parts = [
      js.quoteStyle === 'single' ? 'single quotes' : null,
      js.quoteStyle === 'double' ? 'double quotes' : null,
      indentPart(
        formatter.indentStyle,
        formatter.indentWidth ?? formatter.indentSize,
      ),
      typeof formatter.lineWidth === 'number'
        ? `lines up to ${formatter.lineWidth} characters`
        : null,
      js.trailingCommas === 'all' || js.trailingComma === 'all'
        ? 'trailing commas'
        : null,
      js.trailingCommas === 'none' || js.trailingComma === 'none'
        ? 'no trailing commas'
        : null,
      js.semicolons === 'asNeeded' ? 'semicolons only where needed' : null,
    ].filter((p): p is string => p !== null);
    found.push(
      candidate(
        'Format with Biome',
        `Biome formats the code${parts.length ? `: ${listed(parts)}` : ''}. Run the formatter before committing.`,
        source,
      ),
    );
  }
  const linter = record(json.linter);
  if (json.linter !== undefined && linter.enabled !== false) {
    const recommended = record(linter.rules).recommended !== false;
    found.push(
      candidate(
        'Lint with Biome',
        `Biome is the linter${recommended ? ', with its recommended rules' : ''}. Fix every lint error before committing.`,
        source,
      ),
    );
  }
  return found;
};

const eslintCandidates = (
  json: Json | null,
  source: string,
): RuleCandidate[] => {
  const extended = json?.extends;
  const bases = (Array.isArray(extended) ? extended : [extended]).filter(
    (e): e is string => typeof e === 'string',
  );
  return [
    candidate(
      'Lint with ESLint',
      `ESLint is the linter (${source})${bases.length ? `; the config extends ${listed(bases)}` : ''}. Fix every lint error before committing.`,
      source,
    ),
  ];
};

const prettierCandidates = (json: Json, source: string): RuleCandidate[] => {
  const parts = [
    json.singleQuote === true ? 'single quotes' : null,
    json.singleQuote === false ? 'double quotes' : null,
    json.useTabs === true
      ? 'tab indentation'
      : indentPart(undefined, json.tabWidth),
    json.semi === false ? 'no semicolons' : null,
    json.trailingComma === 'all' || json.trailingComma === 'es5'
      ? 'trailing commas'
      : null,
    json.trailingComma === 'none' ? 'no trailing commas' : null,
    typeof json.printWidth === 'number'
      ? `lines up to ${json.printWidth} characters`
      : null,
  ].filter((p): p is string => p !== null);
  return [
    candidate(
      'Format with Prettier',
      `Prettier formats the code${parts.length ? `: ${listed(parts)}` : ''}. Run it before committing.`,
      source,
    ),
  ];
};

/** The `[*]` section of an .editorconfig (and keys before any section). */
const editorconfigCandidates = (
  text: string,
  source: string,
): RuleCandidate[] => {
  const keys = new Map<string, string>();
  let section: string | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;
    const header = /^\[(.*)\]$/.exec(line);
    if (header) {
      section = header[1] ?? '';
      continue;
    }
    if (section !== null && section !== '*') continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    keys.set(
      line.slice(0, eq).trim().toLowerCase(),
      line
        .slice(eq + 1)
        .trim()
        .toLowerCase(),
    );
  }
  const size = Number(keys.get('indent_size'));
  const parts = [
    indentPart(
      keys.get('indent_style'),
      Number.isInteger(size) && size > 0 ? size : undefined,
    ),
    keys.get('end_of_line') === 'lf' ? 'LF line endings' : null,
    keys.get('end_of_line') === 'crlf' ? 'CRLF line endings' : null,
    keys.get('charset') === 'utf-8' ? 'UTF-8' : null,
    keys.get('insert_final_newline') === 'true' ? 'a final newline' : null,
    keys.get('trim_trailing_whitespace') === 'true'
      ? 'no trailing whitespace'
      : null,
  ].filter((p): p is string => p !== null);
  if (parts.length === 0) return [];
  return [
    candidate(
      'Follow .editorconfig',
      `Every file uses ${listed(parts)}, as .editorconfig sets.`,
      source,
    ),
  ];
};

const STRICT_EXTRAS = [
  'noUncheckedIndexedAccess',
  'exactOptionalPropertyTypes',
  'noImplicitReturns',
  'noImplicitOverride',
  'noUnusedLocals',
  'noUnusedParameters',
  'noFallthroughCasesInSwitch',
];

const tsconfigCandidates = (json: Json, source: string): RuleCandidate[] => {
  const options = record(json.compilerOptions);
  if (options.strict !== true) return [];
  const extras = STRICT_EXTRAS.filter((key) => options[key] === true);
  return [
    candidate(
      'Strict TypeScript',
      `TypeScript runs with strict on (${source})${extras.length ? `, and also ${listed(extras)}` : ''}. Code must compile under it without suppressing errors.`,
      source,
    ),
  ];
};

/** The well-known options of one config file, as rules (#584). */
export const configCandidates = (
  text: string,
  source: string,
): { candidates: RuleCandidate[]; warning?: string } => {
  const name = source.split('/').at(-1) ?? source;
  if (name === '.editorconfig') {
    return { candidates: editorconfigCandidates(text, source) };
  }
  if (name.startsWith('eslint.config.')) {
    return { candidates: eslintCandidates(null, source) };
  }
  let json: unknown;
  try {
    json = parseJsonc(text);
  } catch {
    // `.eslintrc` and `.prettierrc` may be YAML: the tool is still in use.
    if (name === '.eslintrc') {
      return { candidates: eslintCandidates(null, source) };
    }
    if (name === '.prettierrc') {
      return { candidates: prettierCandidates({}, source) };
    }
    return { candidates: [], warning: `${source} is not valid JSON; skipped.` };
  }
  if (!isRecord(json)) {
    return {
      candidates: [],
      warning: `${source} is not a JSON object; skipped.`,
    };
  }
  if (name.startsWith('biome.'))
    return { candidates: biomeCandidates(json, source) };
  if (name.startsWith('.eslintrc')) {
    return { candidates: eslintCandidates(json, source) };
  }
  if (name.startsWith('.prettierrc')) {
    return { candidates: prettierCandidates(json, source) };
  }
  if (name === 'tsconfig.json') {
    return { candidates: tsconfigCandidates(json, source) };
  }
  return { candidates: [] };
};

export interface ScanRulesDeps {
  fs?: ProjectFs;
}

/**
 * `project.scan_rules` (#584): reads only the fixed files above, at `path`.
 * A file that is missing is passed over; one that is larger than
 * `RULE_SCAN_FILE_MAX_BYTES`, binary, or a symlink out of the root is skipped
 * with a warning, never read whole. Candidates are deduplicated by title.
 */
export const scanProjectRules = (
  path: string,
  deps: ScanRulesDeps = {},
): ProjectScanRulesResult => {
  const fs = deps.fs ?? nodeFs;
  if (!isDirectory(fs, path)) {
    throw new CommandFailure('path_not_found', `${path} is not a directory`);
  }
  const root = fs.realpath(path) ?? path;
  const warnings: string[] = [];
  const scanned: string[] = [];

  const read = (relative: string): string | null => {
    const file = join(root, relative);
    if (fs.isSymbolicLink(file)) {
      const real = fs.realpath(file);
      if (!real?.startsWith(root + sep)) {
        warnings.push(`${relative} links outside the project; skipped.`);
        return null;
      }
    }
    const stat = fs.stat(file);
    if (!stat?.isFile) return null;
    if ((stat.size ?? 0) > RULE_SCAN_FILE_MAX_BYTES) {
      warnings.push(`${relative} is larger than 256 KB; skipped.`);
      return null;
    }
    const text = fs.readFile(file);
    if (text === null) return null;
    if (Buffer.byteLength(text) > RULE_SCAN_FILE_MAX_BYTES) {
      warnings.push(`${relative} is larger than 256 KB; skipped.`);
      return null;
    }
    if (text.includes('\u0000')) {
      warnings.push(`${relative} is not a text file; skipped.`);
      return null;
    }
    scanned.push(relative);
    return text;
  };

  const all: RuleCandidate[] = [];
  for (const guide of RULE_SCAN_GUIDES) {
    const text = read(guide);
    if (text !== null) all.push(...guideCandidates(text, guide));
  }
  for (const config of RULE_SCAN_CONFIGS) {
    const text = read(config);
    if (text === null) continue;
    const found = configCandidates(text, config);
    if (found.warning) warnings.push(found.warning);
    all.push(...found.candidates.slice(0, RULE_SCAN_PER_FILE_MAX));
  }

  const seen = new Set<string>();
  const candidates = all.filter((c) => {
    const key = ruleTitleKey(c.title);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return {
    candidates: candidates.slice(0, RULE_SCAN_CANDIDATES_MAX),
    scanned,
    warnings,
  };
};

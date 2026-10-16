import {
  PROJECT_RULE_DESCRIPTION_MAX,
  PROJECT_RULE_TITLE_MAX,
} from './contracts';

/** One rule a Markdown document yields. */
export interface ParsedRule {
  title: string;
  description: string;
}

export interface ParsedRules {
  /** In document order, the first of every title only. */
  rules: ParsedRule[];
  /** The titles dropped because the document repeats them, in document order. */
  duplicates: string[];
}

/** Titles compare case- and whitespace-insensitively. */
export const ruleTitleKey = (title: string): string =>
  title.trim().replace(/\s+/g, ' ').toLowerCase();

const ATX_HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*))?$/;
const LIST_ITEM = /^( *)([-*+]|\d{1,9}[.)])[ \t]+(.*)$/;
const FENCE = /^ *(`{3,}|~{3,})/;

interface Heading {
  line: number;
  level: number;
  text: string;
}

const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;

const cleanTitle = (text: string): string =>
  clip(text.replace(/\s+/g, ' ').trim(), PROJECT_RULE_TITLE_MAX);

/** Leading and trailing blank lines dropped, trailing spaces of each line too. */
const block = (lines: readonly string[]): string =>
  clip(
    lines
      .map((l) => l.trimEnd())
      .join('\n')
      .replace(/^\n+|\n+$/g, ''),
    PROJECT_RULE_DESCRIPTION_MAX,
  );

/** For every line, whether it sits in a fenced code block (fences included). */
const fencedLines = (lines: readonly string[]): boolean[] => {
  const fenced: boolean[] = [];
  let open: string | null = null;
  for (const line of lines) {
    const fence = FENCE.exec(line)?.[1];
    if (open === null) {
      if (fence) open = fence;
      fenced.push(open !== null);
    } else {
      fenced.push(true);
      if (fence?.[0] === open[0] && fence.length >= open.length) open = null;
    }
  }
  return fenced;
};

const headingsOf = (
  lines: readonly string[],
  fenced: readonly boolean[],
): Heading[] => {
  const headings: Heading[] = [];
  lines.forEach((line, i) => {
    if (fenced[i]) return;
    const match = ATX_HEADING.exec(line);
    if (!match) return;
    // An optional closing sequence: `## Title ##`.
    const text = (match[2] ?? '').replace(/(^|[ \t]+)#+[ \t]*$/, '').trim();
    if (text !== '') headings.push({ line: i, level: match[1].length, text });
  });
  return headings;
};

/**
 * The level that splits the document: the shallowest one, unless a single
 * heading there only titles the document (`# Project` over `## …`).
 */
const ruleLevel = (headings: readonly Heading[]): number => {
  const top = Math.min(...headings.map((h) => h.level));
  const atTop = headings.filter((h) => h.level === top);
  const deeper = headings.filter((h) => h.level > top);
  if (atTop.length === 1 && deeper.length > 0) {
    return Math.min(...deeper.map((h) => h.level));
  }
  return top;
};

const fromHeadings = (
  lines: readonly string[],
  headings: readonly Heading[],
): ParsedRule[] => {
  const level = ruleLevel(headings);
  const rules: ParsedRule[] = [];
  headings.forEach((heading, i) => {
    if (heading.level !== level) return;
    const end =
      headings.slice(i + 1).find((h) => h.level <= level)?.line ?? lines.length;
    rules.push({
      title: cleanTitle(heading.text),
      description: block(lines.slice(heading.line + 1, end)),
    });
  });
  return rules;
};

const fromListItems = (
  lines: readonly string[],
  fenced: readonly boolean[],
): ParsedRule[] => {
  const items = lines
    .map((line, i) => ({ i, match: fenced[i] ? null : LIST_ITEM.exec(line) }))
    .filter((x) => x.match !== null);
  if (items.length === 0) return [];
  // Top-level items are the least indented ones; deeper ones are nested.
  const base = Math.min(...items.map((x) => x.match?.[1].length ?? 0));

  const rules: ParsedRule[] = [];
  let current: { first: string; rest: string[]; indent: number } | null = null;
  let blank = false;
  const close = () => {
    if (current === null) return;
    const title = cleanTitle(current.first);
    if (title !== '') {
      rules.push({ title, description: block([current.first, ...current.rest]) });
    }
    current = null;
  };

  lines.forEach((line, i) => {
    const match = fenced[i] ? null : LIST_ITEM.exec(line);
    if (match && match[1].length === base) {
      close();
      current = {
        first: match[3],
        rest: [],
        indent: match[1].length + match[2].length + 1,
      };
      blank = false;
      return;
    }
    if (current === null) return;
    if (line.trim() === '') {
      blank = true;
      current.rest.push('');
      return;
    }
    const indent = line.length - line.trimStart().length;
    // After a blank line only indented text still belongs to the item;
    // before one, a plain line is a lazy continuation of it.
    if (blank && indent <= base && !fenced[i]) {
      close();
      return;
    }
    blank = false;
    current.rest.push(line.slice(Math.min(indent, current.indent)));
  });
  close();
  return rules;
};

/**
 * Splits a Markdown document into coding rules (#528): each top-level heading
 * is a rule, its section the description; a document without headings yields
 * one rule per top-level list item, its first line the title. Headings and
 * list markers inside fenced code do not count. Titles are clipped to
 * `PROJECT_RULE_TITLE_MAX`, descriptions to `PROJECT_RULE_DESCRIPTION_MAX`; a
 * title the document repeats is kept once and reported in `duplicates`.
 */
export const parseRulesMarkdown = (markdown: string): ParsedRules => {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const fenced = fencedLines(lines);
  const headings = headingsOf(lines, fenced);
  const parsed =
    headings.length > 0
      ? fromHeadings(lines, headings)
      : fromListItems(lines, fenced);

  const seen = new Set<string>();
  const rules: ParsedRule[] = [];
  const duplicates: string[] = [];
  for (const rule of parsed) {
    const key = ruleTitleKey(rule.title);
    if (seen.has(key)) {
      duplicates.push(rule.title);
    } else {
      seen.add(key);
      rules.push(rule);
    }
  }
  return { rules, duplicates };
};

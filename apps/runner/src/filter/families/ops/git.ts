import { isProtectedLine } from '../../classify';
import type { Filter } from '../../types';
import {
  cleanLines,
  collapseRepeats,
  elide,
  hasFlag,
  joinLines,
  squeezeBlanks,
  subcommand,
} from './util';

const GIT_VALUE_FLAGS = ['-C', '-c', '--git-dir', '--work-tree', '--namespace'];

const gitCommand = (argv: readonly string[]): string | undefined =>
  subcommand(argv, GIT_VALUE_FLAGS);

/** `git diff` modes that print a summary, not hunks: only capped when long. */
const DIFF_SUMMARIES = [
  '--stat',
  '--shortstat',
  '--numstat',
  '--name-only',
  '--name-status',
  '--summary',
];

const COMMANDS = new Set([
  'status',
  'log',
  'diff',
  'show',
  'fetch',
  'pull',
  'push',
  'clone',
  'branch',
  'stash',
  'remote',
  'tag',
  'blame',
  'reflog',
  'shortlog',
]);

/** A line a transfer prints while it works; only the last state matters. */
const TRANSFER_PROGRESS =
  /^(remote: )?(Enumerating|Counting|Compressing|Writing|Receiving|Resolving|Unpacking|Checking out|Updating|Delta compression|Total \d+)\b.*(objects|deltas|files|threads|objects\b.*\d+%|\d+%)/;

/**
 * Below this, git output goes through unchanged: a short status, a few
 * commits or a one-hunk diff fit on a screen, and the footer that points to
 * the raw output (~150 bytes) would eat most of what a summary saves.
 */
export const GIT_MIN_BYTES = 512;

/** Lines listed per `git status` section; the rest are counted. */
export const GIT_STATUS_LINES = 20;

/** Names listed on one directory's line; the rest are counted. */
const GIT_STATUS_NAMES = 8;

/** `git status` section headers, and the short name each is listed under. */
const STATUS_SECTIONS: Record<string, { name: string; capped: boolean }> = {
  'Changes to be committed:': { name: 'Staged', capped: true },
  'Changes not staged for commit:': { name: 'Not staged', capped: true },
  'Untracked files:': { name: 'Untracked', capped: true },
  'Unmerged paths:': { name: 'Unmerged', capped: false },
  'Ignored files:': { name: 'Ignored', capped: true },
};

/** `<kind>:   <path>` entries of a status section, as porcelain-like codes. */
const STATUS_CODES: Record<string, string> = {
  modified: 'M',
  'new file': 'A',
  deleted: 'D',
  renamed: 'R',
  copied: 'C',
  typechange: 'T',
  'both modified': 'UU',
  'both added': 'AA',
  'both deleted': 'DD',
  'added by us': 'AU',
  'added by them': 'UA',
  'deleted by us': 'DU',
  'deleted by them': 'UD',
};

const STATUS_ENTRY = /^\t(?:([a-z ]+):\s+)?(.+)$/;

interface StatusEntry {
  /** `M`, `?`, … or the kind as git wrote it when it has no code. */
  code: string;
  path: string;
  /** The line as git printed it, when the classifier protects it. */
  kept?: string;
}

interface StatusSection {
  name: string;
  capped: boolean;
  entries: StatusEntry[];
}

const dirOf = (path: string): string => {
  const at = path.replace(/\/$/, '').lastIndexOf('/');
  return at < 0 ? '' : path.slice(0, at + 1);
};

/**
 * A section's entries as lines: neighbours with the same code in the same
 * directory share one, `M src/cart/{a.ts, b.ts}`. A protected entry stays
 * as git printed it.
 */
const statusLines = (entries: readonly StatusEntry[]) => {
  const lines: { text: string; files: number; kept: boolean }[] = [];
  let i = 0;
  while (i < entries.length) {
    const entry = entries[i] as StatusEntry;
    if (entry.kept) {
      lines.push({ text: `  ${entry.kept}`, files: 1, kept: true });
      i++;
      continue;
    }
    const dir = dirOf(entry.path);
    let j = i + 1;
    while (
      j < entries.length &&
      !entries[j]?.kept &&
      entries[j]?.code === entry.code &&
      dirOf(entries[j]?.path ?? '') === dir
    )
      j++;
    const names = entries.slice(i, j).map((e) => e.path.slice(dir.length));
    const more = names.length - GIT_STATUS_NAMES;
    const listed =
      more > 1 ? [...names.slice(0, GIT_STATUS_NAMES), `+${more} more`] : names;
    const text =
      names.length === 1 ? entry.path : `${dir}{${listed.join(', ')}}`;
    lines.push({ text: `  ${entry.code} ${text}`, files: j - i, kept: false });
    i = j;
  }
  return lines;
};

/**
 * `git status` in its long form, summarised (rtk's strategy): each section
 * becomes `Staged (N):` and its files grouped by directory, capped at
 * `GIT_STATUS_LINES`; the `(use "git …")` hints go. The branch lines and
 * anything unrecognised stay as they were.
 */
const statusFilter = (output: string): string | null => {
  const out: string[] = [];
  let section: StatusSection | null = null;
  const flush = () => {
    if (!section) return;
    const { name, capped, entries } = section;
    out.push(`${name} (${entries.length}):`);
    let hidden = 0;
    statusLines(entries).forEach((line, i) => {
      if (!capped || i < GIT_STATUS_LINES || line.kept) out.push(line.text);
      else hidden += line.files;
    });
    if (hidden > 0) out.push(`  … ${hidden} more`);
    section = null;
  };
  for (const line of cleanLines(output)) {
    const header = STATUS_SECTIONS[line.trim()];
    if (header && !line.startsWith('\t')) {
      flush();
      section = { ...header, entries: [] };
      continue;
    }
    if (/^\s+\(use "git /.test(line)) continue;
    const entry = section ? STATUS_ENTRY.exec(line) : null;
    if (section && entry) {
      const [, kind, path = ''] = entry;
      section.entries.push({
        code: (kind ? STATUS_CODES[kind] : '?') ?? `${kind}:`,
        path,
        ...(isProtectedLine(line) ? { kept: line.trim() } : {}),
      });
      continue;
    }
    if (line.trim() === '') continue;
    flush();
    out.push(line);
  }
  flush();
  return joinLines(out);
};

interface Commit {
  sha: string;
  author: string;
  date: string;
  subject: string;
  /** Body lines the classifier protects, which must survive. */
  keep: string[];
  extra: string[];
}

/** `git log` in its default format: one line per commit. */
const logFilter = (output: string): string | null => {
  const lines = cleanLines(output);
  if (!lines[0]?.startsWith('commit ')) return null;
  const commits: Commit[] = [];
  let current: Commit | null = null;
  let inBody = false;
  for (const line of lines) {
    const head = /^commit ([0-9a-f]{7,40})(?: \((.*)\))?/.exec(line);
    if (head) {
      current = {
        sha: (head[1] ?? '').slice(0, 7),
        author: '',
        date: '',
        subject: '',
        keep: [],
        extra: head[2] ? [head[2]] : [],
      };
      commits.push(current);
      inBody = false;
      continue;
    }
    if (!current) return null;
    if (!inBody) {
      if (line.startsWith('Author:')) {
        current.author = line
          .slice('Author:'.length)
          .trim()
          .replace(/ <.*>$/, '');
      } else if (line.startsWith('Date:')) {
        current.date = line.slice('Date:'.length).trim();
      } else if (line.trim() === '' && current.author) {
        inBody = true;
      } else if (/^(Merge|gpg|Commit|AuthorDate|CommitDate):/.test(line)) {
        // header lines of other shapes carry nothing the subject lacks
      } else if (line.trim() !== '') {
        return null; // not the default format
      }
      continue;
    }
    const text = line.trim();
    if (text === '') continue;
    if (!current.subject) current.subject = text;
    else if (isProtectedLine(line)) current.keep.push(line.trimEnd());
  }
  if (commits.some((c) => !c.subject && !c.author)) return null;
  const out: string[] = [];
  for (const c of commits) {
    const refs = c.extra.length > 0 ? ` (${c.extra.join(', ')})` : '';
    out.push(`${c.sha}${refs} ${c.date} ${c.author}: ${c.subject}`);
    // The subject may itself be the protected line; it is already on top.
    for (const kept of c.keep)
      if (!out[out.length - 1]?.includes(kept.trim()))
        out.push(`    ${kept.trim()}`);
  }
  return joinLines(out);
};

/** Header lines of a file in a diff that say nothing the stat does not. */
const DIFF_META =
  /^(index [0-9a-f]+\.\.[0-9a-f]+|similarity index|old mode|new mode|--- (a\/|\/dev\/null)|\+\+\+ (b\/|\/dev\/null))/;

/** Context lines kept on each side of a change; git prints three. */
const DIFF_CONTEXT = 1;

/** A run of context this long is replaced by a marker; a shorter one just goes. */
const DIFF_CONTEXT_MARKER = 4;

/** A hunk longer than this keeps its head and tail (a new or rewritten file). */
export const DIFF_HUNK_LINES = 30;
const DIFF_HUNK_HEAD = 20;
const DIFF_HUNK_TAIL = 5;

/**
 * Hunk lines shown per file. Past it, a hunk keeps only its `@@` line and its
 * protected lines: the stat header still counts every change, and the raw
 * output has them all.
 */
export const DIFF_FILE_LINES = 40;

interface DiffFile {
  path: string;
  added: number;
  removed: number;
  note: string;
  /** Hunk lines shown so far, against `DIFF_FILE_LINES`. */
  shown: number;
}

const isChange = (line: string | undefined): boolean =>
  line !== undefined && /^[-+\\]/.test(line);

/**
 * One hunk's body: context trimmed to `DIFF_CONTEXT`, then capped — to
 * nothing but its protected lines once its file is over `DIFF_FILE_LINES`.
 */
const hunkBody = (lines: readonly string[], file: DiffFile): string[] => {
  if (file.shown >= DIFF_FILE_LINES) return elide(lines, { head: 0, tail: 0 });
  const trimmed: string[] = [];
  let dropped = 0;
  const flushDropped = () => {
    if (dropped >= DIFF_CONTEXT_MARKER) {
      trimmed.push(`… ${dropped} unchanged lines`);
    }
    dropped = 0;
  };
  lines.forEach((line, i) => {
    const near = lines
      .slice(Math.max(0, i - DIFF_CONTEXT), i + DIFF_CONTEXT + 1)
      .some(isChange);
    if (isChange(line) || near || isProtectedLine(line)) {
      flushDropped();
      trimmed.push(line);
    } else {
      dropped++;
    }
  });
  flushDropped();
  const body =
    trimmed.length <= DIFF_HUNK_LINES
      ? trimmed
      : elide(trimmed, { head: DIFF_HUNK_HEAD, tail: DIFF_HUNK_TAIL });
  file.shown += body.length;
  return body;
};

/**
 * A unified diff (rtk's strategy): a stat header, then each hunk with its
 * context trimmed to one line around the changes, long hunks capped and each
 * file capped at `DIFF_FILE_LINES`. The
 * `index` and `---` / `+++` lines go; everything outside the hunks (a commit
 * header of `git show` or `log -p`) stays.
 */
const diffFilter = (output: string): string | null => {
  const lines = cleanLines(output);
  if (!lines.some((l) => l.startsWith('diff --git '))) return null;
  const files: DiffFile[] = [];
  const out: string[] = [];
  let file: DiffFile | null = null;
  let hunk: string[] | null = null;
  const endHunk = () => {
    if (hunk && file) out.push(...hunkBody(hunk, file));
    hunk = null;
  };
  for (const line of lines) {
    const start = /^diff --git a\/.+ b\/(.+)$/.exec(line);
    if (start) {
      endHunk();
      file = {
        path: start[1] ?? '',
        added: 0,
        removed: 0,
        note: '',
        shown: 0,
      };
      files.push(file);
      out.push(line);
      continue;
    }
    if (line.startsWith('@@')) {
      endHunk();
      hunk = [];
      out.push(line);
      continue;
    }
    if (hunk && file && (/^[-+ \\]/.test(line) || line === '')) {
      if (line.startsWith('+')) file.added++;
      if (line.startsWith('-')) file.removed++;
      hunk.push(line);
      continue;
    }
    endHunk();
    if (file && /^new file mode/.test(line)) file.note = ' (new)';
    if (file && /^deleted file mode/.test(line)) file.note = ' (deleted)';
    if (/^(new|deleted) file mode/.test(line) && !isProtectedLine(line)) {
      continue;
    }
    if (DIFF_META.test(line) && !isProtectedLine(line)) continue;
    out.push(line);
  }
  endHunk();
  const added = files.reduce((n, f) => n + f.added, 0);
  const removed = files.reduce((n, f) => n + f.removed, 0);
  const width = Math.max(...files.map((f) => f.path.length));
  const stat = [
    `${files.length} ${files.length === 1 ? 'file' : 'files'} changed, +${added} -${removed}`,
    ...files.map(
      (f) => ` ${f.path.padEnd(width)} | +${f.added} -${f.removed}${f.note}`,
    ),
    '',
  ];
  return joinLines([...stat, ...out]);
};

const transferFilter = (output: string): string | null => {
  const lines = cleanLines(output).filter(
    (line) => !TRANSFER_PROGRESS.test(line),
  );
  return joinLines(squeezeBlanks(lines));
};

/** Anything else that can run long: its tail and head, and what matters. */
const longFilter = (output: string): string | null =>
  joinLines(elide(collapseRepeats(cleanLines(output)), { head: 40, tail: 20 }));

export const gitFilter: Filter = {
  id: 'ops/git',
  matches: (argv) => argv[0] === 'git' && COMMANDS.has(gitCommand(argv) ?? ''),
  apply: ({ argv, output }) => {
    if (Buffer.byteLength(output) < GIT_MIN_BYTES) return null;
    switch (gitCommand(argv)) {
      case 'status':
        // Porcelain is for scripts to parse: never reshaped.
        if (hasFlag(argv, '--porcelain', '-z')) return null;
        return hasFlag(argv, '--short', '-s')
          ? longFilter(output)
          : statusFilter(output);
      case 'log':
        if (hasFlag(argv, '-p', '--patch')) {
          return diffFilter(output) ?? longFilter(output);
        }
        return hasFlag(argv, '--oneline', '--pretty', '--format', '--graph')
          ? longFilter(output)
          : (logFilter(output) ?? longFilter(output));
      case 'diff':
      case 'show':
        if (hasFlag(argv, ...DIFF_SUMMARIES)) return longFilter(output);
        return diffFilter(output) ?? longFilter(output);
      case 'fetch':
      case 'pull':
      case 'push':
      case 'clone':
        return transferFilter(output);
      default:
        return longFilter(output);
    }
  },
};

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

const statusFilter = (output: string): string | null => {
  const lines = cleanLines(output).filter(
    (line) => !/^\s+\(use "git /.test(line),
  );
  return joinLines(squeezeBlanks(lines));
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

const DIFF_META =
  /^(index [0-9a-f]+\.\.[0-9a-f]+|similarity index|new file mode|deleted file mode|old mode|new mode)/;

/** A unified diff: no `index` lines, and one line of context around changes. */
const diffFilter = (output: string): string | null => {
  const lines = cleanLines(output);
  if (!lines.some((l) => l.startsWith('diff --git ') || l.startsWith('@@ '))) {
    return null;
  }
  const isContext = (l: string) => l.startsWith(' ') || l === '';
  const changed = (l: string | undefined) =>
    l !== undefined && (l.startsWith('+') || l.startsWith('-'));
  const out: string[] = [];
  let inHunk = false;
  lines.forEach((line, i) => {
    if (line.startsWith('diff --git ') || line.startsWith('commit ')) {
      inHunk = false;
    }
    if (line.startsWith('@@ ')) inHunk = true;
    if (DIFF_META.test(line)) return;
    if (inHunk && isContext(line) && !isProtectedLine(line)) {
      const near = changed(lines[i - 1]) || changed(lines[i + 1]);
      if (!near) return;
    }
    out.push(line);
  });
  return joinLines(out);
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
    switch (gitCommand(argv)) {
      case 'status':
        return hasFlag(argv, '--short', '-s', '--porcelain')
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

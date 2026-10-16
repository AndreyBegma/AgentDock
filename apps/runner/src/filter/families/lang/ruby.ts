import { isProtectedLine } from '../../classify';
import type { Filter } from '../../types';
import {
  cleanLines,
  dropNoise,
  effective,
  joinLines,
  looksLikeJson,
  squeezeBlanks,
} from './util';

/**
 * rspec, rubocop and bundler. rspec drops the progress dots and, in
 * documentation format, every passing example; rubocop drops the progress and
 * the source snippet under each offense; bundler drops the per-gem lines.
 */

const indentOf = (line: string): number =>
  line.length - line.trimStart().length;

const RSPEC_DOC_END =
  /^(Pending:|Failures:|Failed examples:|Finished in |Top \d+ slowest)/;
const RSPEC_PROGRESS = /^[.*P]+$/;

export const rspecFilter: Filter = {
  id: 'lang/rspec',
  matches: (argv) => effective(argv)[0] === 'rspec',
  apply: ({ output }) => {
    if (looksLikeJson(output)) return null;
    const lines = cleanLines(output);
    if (!lines.some((l) => /^\d+ examples?, \d+ failures?/.test(l)))
      return null;

    const end = lines.findIndex((l) => RSPEC_DOC_END.test(l));
    const head = end === -1 ? lines : lines.slice(0, end);
    const tail = end === -1 ? [] : lines.slice(end);

    // The head is a progress line of dots, or documentation format: a tree of
    // groups and examples in which only failed and pending examples matter.
    const kept: string[] = [];
    const ancestors: { indent: number; index: number }[] = [];
    const keep = new Set<number>();
    head.forEach((line, i) => {
      if (line.trim() === '') return;
      if (/^(Randomized with seed|Run options:)/.test(line)) {
        keep.add(i);
        return;
      }
      if (RSPEC_PROGRESS.test(line)) return;
      const indent = indentOf(line);
      while (
        ancestors.length > 0 &&
        (ancestors.at(-1)?.indent ?? 0) >= indent
      ) {
        ancestors.pop();
      }
      ancestors.push({ indent, index: i });
      if (
        /\((FAILED - \d+|PENDING\b.*)\)$/.test(line) ||
        isProtectedLine(line)
      ) {
        for (const a of ancestors) keep.add(a.index);
      }
    });
    head.forEach((line, i) => {
      if (keep.has(i)) kept.push(line);
    });
    return joinLines(squeezeBlanks([...kept, '', ...tail]));
  },
};

const OFFENSE = /^\S+:\d+:\d+: [CWEFRI]: /;
const RUBOCOP_PROGRESS = /^[.CWEFA]+$/;

export const rubocopFilter: Filter = {
  id: 'lang/rubocop',
  matches: (argv) => effective(argv)[0] === 'rubocop',
  apply: ({ output }) => {
    if (looksLikeJson(output)) return null;
    const lines = cleanLines(output);
    if (!lines.some((l) => /^\d+ files? inspected, /.test(l))) return null;

    const out: string[] = [];
    let inOffense = false;
    for (const line of lines) {
      if (OFFENSE.test(line)) {
        inOffense = true;
        out.push(line);
        continue;
      }
      if (line.trim() === '') inOffense = false;
      // the code and the caret line under an offense
      if (inOffense && /^\s+\S/.test(line) && !isProtectedLine(line)) continue;
      if (RUBOCOP_PROGRESS.test(line) && !isProtectedLine(line)) continue;
      out.push(line);
    }
    return joinLines(squeezeBlanks(out));
  },
};

const BUNDLE_NOISE =
  /^(Using|Fetching|Installing) \S+( \([^)]*\)| [\d.]+\S*)?( with native extensions)?(\.{3,})?$|^Fetching (gem metadata|source index)|^Resolving dependencies|^Don't run Bundler as root/;

export const bundleFilter: Filter = {
  id: 'lang/bundle',
  matches: (argv) => {
    if (argv[0] !== 'bundle' && argv[0] !== 'bundler') return false;
    const sub = argv.slice(1).find((a) => !a.startsWith('-'));
    return sub === undefined || sub === 'install' || sub === 'update';
  },
  apply: ({ output }) => {
    const lines = cleanLines(output);
    if (
      !lines.some((l) =>
        /^(Bundle complete!|Bundle updated!|Fetching gem metadata|Using bundler)/.test(
          l,
        ),
      )
    ) {
      return null;
    }
    return joinLines(squeezeBlanks(dropNoise(lines, BUNDLE_NOISE)));
  },
};

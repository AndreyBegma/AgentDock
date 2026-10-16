import { isProtectedLine } from '../../classify';
import {
  type Compress,
  dropMatching,
  finish,
  plainLines,
  splitLines,
  survivors,
} from './util';

/**
 * Package managers: `install`/`add`/`remove` and `outdated` for bun, npm,
 * pnpm and yarn. What goes: the list of every package added, progress
 * counters, funding and upgrade notices and the padding of a table. What
 * stays: the summary, every warning and error.
 */

const matchesAny = (output: string, ...patterns: RegExp[]): boolean => {
  const lines = plainLines(splitLines(output));
  return patterns.some((pattern) => lines.some((line) => pattern.test(line)));
};

export const compressInstall: Compress = (output) => {
  const recognised = matchesAny(
    output,
    /^bun (install|add|remove|update) v\d/,
    /^\d+ packages? installed/,
    /^(added|removed|changed) \d+ packages?|^up to date, audited/,
    /^Done in \d/,
    /^Progress: resolved \d+/,
    /^Lockfile is up to date|^Already up to date/,
    /^\[\d\/\d\] /,
    /^➤ YN\d+: /,
  );
  if (!recognised) return null;
  return dropMatching(
    output,
    (p) =>
      // bun: `+ pkg@1.2.3` per package
      /^\+ \S+@\S+\s*$/.test(p) ||
      // npm: funding and upgrade notices
      /^\d+ packages? (is|are) looking for funding\s*$/.test(p) ||
      /^\s+run `(npm|pnpm|yarn) fund` for details\s*$/.test(p) ||
      /^npm notice/.test(p) ||
      // pnpm: the progress counter of every tick but the last, the bar
      (/^Progress: resolved \d+/.test(p) && !/, done\s*$/.test(p)) ||
      /^[+-]{4,}\s*$/.test(p) ||
      /^Scope: /.test(p) ||
      /^(dev|optional)?[dD]ependencies:\s*$/.test(p) ||
      /^\+ \S+ \d\S*(\s+\(.*\))?\s*$/.test(p) ||
      // yarn: step counters and resolution chatter
      /^\[\d\/\d\] /.test(p) ||
      /^info (No lockfile found|fsevents)/.test(p) ||
      /^➤ YN0000: [│┌└]/.test(p),
  );
};

/** `outdated`: the table without its padding and drawn borders. */
export const compressOutdated: Compress = (output) => {
  if (!matchesAny(output, /\bCurrent\b.*\b(Wanted|Update|Latest)\b/))
    return null;
  const lines = splitLines(output);
  const plain = plainLines(lines);
  const dropped = plain.map(
    (p) => /^[|+\-─┌┐└┘├┤┬┴┼│\s]+$/.test(p) && p.trim().length > 0,
  );
  const kept = survivors(lines, dropped).map((line) =>
    isProtectedLine(line) ? line : line.replace(/ {2,}/g, ' '),
  );
  return finish(output, kept);
};

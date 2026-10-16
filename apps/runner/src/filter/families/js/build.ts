import { type Compress, dropMatching, plainLines, splitLines } from './util';

/**
 * Build tools: `next build`, `prisma generate|migrate`, `turbo run`. What
 * goes: the route table, progress counters, the file tree a migration prints
 * and the per-task noise turbo adds. What stays: the phases, every
 * diagnostic, the summary.
 */

const has = (output: string, pattern: RegExp): boolean =>
  plainLines(splitLines(output)).some((p) => pattern.test(p));

/** `next build`: the route table and the page-generation progress go. */
export const compressNextBuild: Compress = (output) => {
  if (
    !has(output, /Next\.js \d|Creating an optimized production build|^Route \(/)
  ) {
    return null;
  }
  return dropMatching(
    output,
    (p) =>
      /^\s*[┌├└│]\s/.test(p) ||
      /^\s+Generating static pages using \d+ workers \(\d+\/\d+\)\s*$/.test(
        p,
      ) ||
      /^\s+\d+ \|/.test(p) ||
      /^\s+\|\s+\^+\s*$/.test(p),
  );
};

/** `prisma generate|migrate|db push`: the tree of applied files and the tips go. */
export const compressPrisma: Compress = (output) => {
  if (
    !has(output, /^Prisma schema loaded from|Prisma Client|migrations? found/)
  ) {
    return null;
  }
  return dropMatching(
    output,
    (p) =>
      /^\s*(└─|├─|│)/.test(p) ||
      /^migrations\/\s*$/.test(p) ||
      /^Start by importing your Prisma Client/.test(p) ||
      /^\s*Tip:/.test(p),
  );
};

/** `turbo run`: the preamble, the cache lines and the empty task lines go. */
export const compressTurbo: Compress = (output) => {
  if (!has(output, /^\s*Tasks:\s+\d+|^• turbo \d|^• Packages in scope/)) {
    return null;
  }
  return dropMatching(
    output,
    (p) =>
      /^• (Packages in scope|Remote caching)/.test(p) ||
      /^\S+: cache (hit|miss|bypass)/.test(p) ||
      /^[^\s:]+:[^\s:]+:\s*$/.test(p) ||
      /^[^\s:]+:[^\s:]+: \$ /.test(p),
  );
};

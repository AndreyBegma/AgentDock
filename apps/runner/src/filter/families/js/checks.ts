import {
  type Compress,
  dropMatching,
  finish,
  plainLines,
  splitLines,
  survivors,
} from './util';

/**
 * Type checkers and linters: tsc, biome, prettier. What goes: the source
 * snippet around a diagnostic (its `file:line` header stays), explanatory
 * notes, suggested-fix diffs and the middle of a long elaboration chain.
 * What stays: every diagnostic, with its location and message.
 */

const TS_ERROR = /\berror TS\d+:/;

/**
 * `tsc`: one line per error, or the `--pretty` form with a source snippet
 * and `~~~` underline under each. An error that elaborates over many lines
 * (`Types of property … are incompatible`) keeps its first and last line.
 */
export const compressTsc: Compress = (output) => {
  const lines = splitLines(output);
  const plain = plainLines(lines);
  if (!plain.some((p) => TS_ERROR.test(p))) return null;
  const dropped = plain.map(() => false);
  for (let i = 0; i < plain.length; i++) {
    const p = plain[i] ?? '';
    if (/^\s*~+\s*$/.test(p)) {
      dropped[i] = true;
      if (/^\s*\d+\s/.test(plain[i - 1] ?? '')) dropped[i - 1] = true;
    }
    if (!TS_ERROR.test(p)) continue;
    let end = i + 1;
    while (
      end < plain.length &&
      /^\s{2,}\S/.test(plain[end] ?? '') &&
      !TS_ERROR.test(plain[end] ?? '')
    ) {
      end++;
    }
    for (let k = i + 2; k < end - 1; k++) dropped[k] = true;
  }
  return finish(output, survivors(lines, dropped));
};

const BIOME_HEADER = /━{3,}\s*$/;
const BIOME_FIX = /^\s+i\s+(Safe|Unsafe) fix:/;

/**
 * `biome check|lint|format|ci`: each diagnostic is a header line
 * (`file:line:col rule ━━━`), a message, a source frame, a note and often a
 * fix diff. Keeps the header, the message and the marked source line.
 */
export const compressBiome: Compress = (output) => {
  const lines = splitLines(output);
  const plain = plainLines(lines);
  const diagnostics = plain.some((p) => BIOME_HEADER.test(p));
  if (!diagnostics && !plain.some((p) => /^Checked \d+ files? in /.test(p))) {
    return null;
  }
  let inDetail = false;
  const dropped = plain.map((p) => {
    if (BIOME_HEADER.test(p) || /^(Checked|Formatted|Fixed|Found) /.test(p)) {
      inDetail = false;
      return false;
    }
    if (inDetail) return true;
    if (BIOME_FIX.test(p) || /Formatter would have printed/.test(p)) {
      inDetail = true;
      return false;
    }
    return (
      /^\s+i\s/.test(p) ||
      /^\s+\d+\s+│/.test(p) ||
      (p.length > 0 && p.trim().length === 0)
    );
  });
  return finish(output, survivors(lines, dropped));
};

/**
 * `prettier --write`: one line per file with its time. Unchanged files go;
 * the files that were rewritten stay.
 */
export const compressPrettier: Compress = (output) => {
  const timed = /^\S.* \d+ms( \(unchanged\)| \(cached\))?$/;
  const lines = plainLines(splitLines(output));
  if (!lines.some((p) => timed.test(p))) return null;
  return dropMatching(output, (p) => / \d+ms \((unchanged|cached)\)$/.test(p));
};

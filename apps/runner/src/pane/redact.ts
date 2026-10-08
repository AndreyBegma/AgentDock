/** What replaces a masked secret (spec 18 D5). */
export const MASK = '•••';

/** Single-line token shapes. Best-effort: an ANSI code inside a token defeats a match. */
const TOKENS: readonly RegExp[] = [
  /gh[pousr]_[A-Za-z0-9]{36,}/g,
  /sk-[A-Za-z0-9_-]{20,}/g,
  /xox[abprs]-[A-Za-z0-9-]{10,}/g,
  /AKIA[0-9A-Z]{16}/g,
];

const KEY_BEGIN = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const KEY_END = /-----END [A-Z ]*PRIVATE KEY-----/;

/**
 * Masks secret-looking strings in a capture (spec 18 D5). A private-key block
 * is masked from its `BEGIN` marker through its `END` marker, however many
 * lines it spans; one that is cut off by the top of the capture has no marker
 * to start from and is left alone.
 */
export const redact = (lines: readonly string[]): string[] => {
  let inKey = false;
  return lines.map((line) => {
    if (inKey) {
      const end = KEY_END.exec(line);
      if (!end) return MASK;
      inKey = false;
      return MASK + line.slice(end.index + end[0].length);
    }
    const begin = KEY_BEGIN.exec(line);
    if (begin) {
      const rest = line.slice(begin.index);
      const end = KEY_END.exec(rest);
      if (end) {
        return (
          maskTokens(line.slice(0, begin.index)) +
          MASK +
          maskTokens(rest.slice(end.index + end[0].length))
        );
      }
      inKey = true;
      return maskTokens(line.slice(0, begin.index)) + MASK;
    }
    return maskTokens(line);
  });
};

const maskTokens = (text: string): string =>
  TOKENS.reduce((acc, pattern) => acc.replace(pattern, MASK), text);

/** A digest line's title: a card title, a run title, a slot name. */
export const DIGEST_TITLE_MAX = 120;
/** A digest line's reason — an incident's one line (D12), haiku's for `unknown`. */
export const DIGEST_REASON_MAX = 200;
/** haiku's summary, when a runner writes one. */
export const DIGEST_PROSE_MAX = 600;

/** C0 and C1 control characters (line breaks included) and the Unicode line/paragraph separators. */
const isBreak = (code: number): boolean =>
  code <= 0x1f ||
  (code >= 0x7f && code <= 0x9f) ||
  code === 0x2028 ||
  code === 0x2029;

/**
 * A string that may have been written by a model or a person, as one bounded
 * line (delta audit DA-13): control characters and line breaks become one
 * space, runs of whitespace collapse, and the rest is cut to `max` characters
 * with an ellipsis. Every digest string passes through it before it is stored
 * or sent, so a stored reason can never carry a second line or run past its
 * bound.
 */
export const oneLine = (text: string, max: number): string => {
  const spaced = Array.from(text, (char) =>
    isBreak(char.codePointAt(0) ?? 0) ? ' ' : char,
  ).join('');
  const chars = Array.from(spaced.replace(/\s+/g, ' ').trim());
  return chars.length > max
    ? `${chars.slice(0, max - 1).join('')}…`
    : chars.join('');
};

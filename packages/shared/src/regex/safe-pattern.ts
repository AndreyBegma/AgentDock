/**
 * Admin-supplied regular expressions (trigger `valuePattern`, price
 * `matchPattern`) run on text a stranger chooses. JavaScript's engine
 * backtracks, so a pattern like `^(a+)+$` stalls the event loop on a crafted
 * value. A pattern is therefore stored only when it is short, compiles and has
 * no shape that backtracks exponentially, and it is matched only against
 * bounded input.
 */

/** Longest pattern an admin may store. */
export const SAFE_PATTERN_MAX_CHARS = 200;
/** Longest input a stored pattern is ever matched against. */
export const SAFE_MATCH_INPUT_MAX_CHARS = 1000;

export const SAFE_PATTERN_ERRORS = {
  tooLong: 'too_long',
  invalid: 'invalid',
  nestedQuantifier: 'nested_quantifier',
} as const;
export type SafePatternError =
  (typeof SAFE_PATTERN_ERRORS)[keyof typeof SAFE_PATTERN_ERRORS];

export type SafePatternCheck =
  | { ok: true }
  | { ok: false; reason: SafePatternError };

export const SAFE_PATTERN_MESSAGES: Record<SafePatternError, string> = {
  too_long: `The pattern is longer than ${SAFE_PATTERN_MAX_CHARS} characters.`,
  invalid: 'The pattern is not a valid regular expression.',
  nested_quantifier:
    'The pattern repeats a group that itself repeats or branches, which can stall matching.',
};

interface Item {
  src: string;
  group: Frame | null;
  /** 1 when not repeated (or `?`), more when the item can repeat. */
  max: number;
}

interface Frame {
  items: Item[];
  alternation: boolean;
  /** Something inside can repeat more than once. */
  repeats: boolean;
}

const newFrame = (): Frame => ({
  items: [],
  alternation: false,
  repeats: false,
});

const QUANTIFIER = /^\{(\d+)(?:,(\d*))?\}/;

/** End index (exclusive) of the escape starting at `start` (a backslash); -1 for a backreference. */
const escapeEnd = (p: string, start: number): number => {
  const c = p[start + 1];
  if (c === undefined) return -1;
  if ((c >= '1' && c <= '9') || c === 'k') return -1;
  if ((c === 'u' || c === 'p' || c === 'P') && p[start + 2] === '{') {
    const close = p.indexOf('}', start + 3);
    return close === -1 ? -1 : close + 1;
  }
  if (c === 'x') return start + 4;
  if (c === 'u') return start + 6;
  if (c === 'c') return start + 3;
  return start + 2;
};

/** The one character a group's body must start with, when it is a plain literal. */
const delimiterOf = (item: Item | undefined): string | null => {
  if (!item || item.group || item.max !== 1) return null;
  if (item.src.length === 1 && !'.^$|?*+()[]{}\\'.includes(item.src)) {
    return item.src;
  }
  if (
    item.src.length === 2 &&
    item.src[0] === '\\' &&
    /[^\w]/.test(item.src[1])
  ) {
    return item.src[1];
  }
  return null;
};

/**
 * `(-\d+)*` repeats a group around a repeat, yet each round must consume its
 * leading `-`, which the inner repeat cannot match: the split is unambiguous.
 */
const delimited = (group: Frame): boolean => {
  if (group.alternation) return false;
  const delimiter = delimiterOf(group.items[0]);
  if (delimiter === null) return false;
  for (const item of group.items.slice(1)) {
    if (item.group) return false;
    if (item.max <= 1) continue;
    try {
      if (new RegExp(`^(?:${item.src})$`, 'iu').test(delimiter)) return false;
    } catch {
      return false;
    }
  }
  return true;
};

/**
 * True when a group that can repeat holds another repeat or a branch — the
 * shapes that backtrack exponentially (`(a+)+`, `(a|a)*`, `(a{1,9})*`) — or
 * when the pattern uses a backreference. A conservative scan: it may refuse a
 * pattern that is in fact safe, never accept one of those shapes.
 */
export const hasNestedQuantifier = (pattern: string): boolean => {
  const stack: Frame[] = [newFrame()];
  const top = (): Frame => stack[stack.length - 1];
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === '\\') {
      const end = escapeEnd(pattern, i);
      if (end === -1) return true;
      top().items.push({ src: pattern.slice(i, end), group: null, max: 1 });
      i = end;
    } else if (c === '[') {
      let j = i + 1;
      while (j < pattern.length && pattern[j] !== ']') {
        j += pattern[j] === '\\' ? 2 : 1;
      }
      top().items.push({
        src: pattern.slice(i, j + 1),
        group: null,
        max: 1,
      });
      i = j + 1;
    } else if (c === '(') {
      i += 1;
      if (pattern[i] === '?') {
        const kind = pattern[i + 1];
        if (kind === ':' || kind === '=' || kind === '!') i += 2;
        else if (
          kind === '<' &&
          (pattern[i + 2] === '=' || pattern[i + 2] === '!')
        )
          i += 3;
        else if (kind === '<') {
          const close = pattern.indexOf('>', i);
          if (close === -1) return true;
          i = close + 1;
        } else return true;
      }
      stack.push(newFrame());
    } else if (c === ')') {
      const frame = stack.pop();
      if (frame === undefined || stack.length === 0) return true;
      top().repeats ||= frame.repeats;
      top().items.push({ src: '', group: frame, max: 1 });
      i += 1;
    } else if (c === '|') {
      top().alternation = true;
      i += 1;
    } else {
      let max = -1;
      let width = 1;
      if (c === '*' || c === '+') max = Number.POSITIVE_INFINITY;
      else if (c === '?') max = 1;
      else if (c === '{') {
        const m = QUANTIFIER.exec(pattern.slice(i));
        if (m) {
          width = m[0].length;
          max =
            m[2] === undefined
              ? Number(m[1])
              : m[2] === ''
                ? Number.POSITIVE_INFINITY
                : Number(m[2]);
        }
      }
      if (max === -1) {
        top().items.push({ src: c, group: null, max: 1 });
        i += 1;
        continue;
      }
      i += width;
      if (pattern[i] === '?') i += 1; // lazy
      const item = top().items[top().items.length - 1];
      if (!item) return true;
      item.max = max;
      if (max > 1) {
        if (item.group && (item.group.repeats || item.group.alternation)) {
          if (!delimited(item.group)) return true;
        }
        top().repeats = true;
      }
    }
  }
  return stack.length !== 1;
};

/** Drops the leading `(?i)` Langfuse writes; JavaScript has no inline flags. */
const withoutInlineFlag = (pattern: string): string =>
  pattern.replace(/^\(\?i\)/, '');

/** Whether a pattern may be stored: short, compiles under `flags`, no exponential shape. */
export const checkSafePattern = (
  pattern: string,
  flags: string,
): SafePatternCheck => {
  if (pattern.length > SAFE_PATTERN_MAX_CHARS) {
    return { ok: false, reason: SAFE_PATTERN_ERRORS.tooLong };
  }
  const source = withoutInlineFlag(pattern);
  try {
    new RegExp(source, flags);
  } catch {
    return { ok: false, reason: SAFE_PATTERN_ERRORS.invalid };
  }
  return hasNestedQuantifier(source)
    ? { ok: false, reason: SAFE_PATTERN_ERRORS.nestedQuantifier }
    : { ok: true };
};

/**
 * A price's `matchPattern` as the pricer compiles it: case-insensitive, the
 * inline `(?i)` dropped. Throws a `SyntaxError` on an invalid regex.
 */
export const compileMatchPattern = (pattern: string): RegExp =>
  new RegExp(withoutInlineFlag(pattern), 'i');

/**
 * `regex.test(input)` for input a stranger chose: input over
 * `SAFE_MATCH_INPUT_MAX_CHARS` does not match, so no pattern ever scans an
 * unbounded string.
 */
export const testBounded = (regex: RegExp, input: string): boolean =>
  input.length <= SAFE_MATCH_INPUT_MAX_CHARS && regex.test(input);

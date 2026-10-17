/**
 * The lines a filter must never remove (#445 D4b): errors, failures,
 * warnings and stack frames. The engine checks every filter's result against
 * this, and so does the corpus harness; a filter that drops one of these
 * lines is overruled and the agent gets the original output.
 *
 * Deliberately broad: a false positive only makes a filter keep a line it
 * could have dropped; a false negative could hide the line the agent needed.
 */

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes start with ESC.
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*(\u0007|\u001b\\)/g;

/** The output without colour and cursor escapes, as a person would read it. */
export const stripAnsi = (text: string): string => text.replace(ANSI, '');

const WORDS =
  /\b(errors?|err!|fail|fails|failed|failure|failures|failing|fatal|panic|panicked|exception|exceptions|traceback|warn|warning|warnings|deprecated|deprecation|assert(ion)?(error)?|abort(ed)?|segmentation fault|core dumped|denied|refused|cannot|can't|unable|not found|no such file|undefined reference|unresolved|timed? ?out|killed)\b/i;

const MARKS =
  /[✗✖×✘❌⚠‼⛔]|^\s*(FAIL|ERR|ERROR|WARN|WARNING|E|F)\b|^not ok\b|\b(ERR|WARN)!/;

const STACK = [
  /^\s+at\s+\S/, // JS, JVM, .NET
  /^\s*File "[^"]+", line \d+/, // Python
  /^\s*\S+\.(go|rs|py|rb|php|java|kt|cs|ts|tsx|js|jsx|mjs|cjs|c|cc|cpp|h|hpp|swift):\d+/, // file:line
  /^\s*-->\s+\S+:\d+/, // Rust
  /^goroutine \d+ \[/, // Go
  /^\s+\d+:\s+0x[0-9a-f]+/, // Rust / C backtrace
  /^\s*#\d+\s+\S/, // gdb, PHP
  /^\s*from \S+:\d+:in /, // Ruby
  /^E\s{2,}\S/, // pytest's assertion detail
  /^\s*Caused by:/, // JVM, Rust
];

/** Whether a line is one a filter must keep. */
export const isProtectedLine = (line: string): boolean => {
  const plain = stripAnsi(line);
  if (plain.trim().length === 0) return false;
  return (
    WORDS.test(plain) ||
    MARKS.test(plain) ||
    STACK.some((pattern) => pattern.test(plain))
  );
};

/**
 * The part of a line the classifier judges — the whole line unless a filter
 * says otherwise (`Filter.protectedPart`).
 */
export type LinePart = (line: string) => string;

const wholeLine: LinePart = (line) => line;

/** The distinct protected lines of an output, trimmed, without escapes. */
export const protectedLines = (
  output: string,
  part: LinePart = wholeLine,
): string[] => {
  const seen = new Set<string>();
  for (const line of output.split('\n')) {
    const text = part(stripAnsi(line));
    if (isProtectedLine(text)) seen.add(text.trim());
  }
  return [...seen];
};

/**
 * The protected lines of `original` that `kept` lost. A line survives when
 * its text appears in the kept output (escapes ignored), so a filter may
 * re-indent, recolour or deduplicate it but not drop or shorten it. With a
 * `part`, only that part of each line is judged and has to survive.
 */
export const missingProtectedLines = (
  original: string,
  kept: string,
  part: LinePart = wholeLine,
): string[] => {
  const haystack = stripAnsi(kept);
  return protectedLines(original, part).filter(
    (line) => !haystack.includes(line),
  );
};

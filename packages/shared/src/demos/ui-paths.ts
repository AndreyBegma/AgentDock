/**
 * C-370: whether a pull request makes a card a UI card — one that changes a
 * file matching any of the project's `demoUiPaths` globs. A glob is over
 * repository-relative paths: `*` and `?` match within one segment, `**`
 * matches any number of whole segments (none included), and every other
 * character matches itself.
 */

const escapeRegex = (char: string): string =>
  /[\\^$.|+()[\]{}]/.test(char) ? `\\${char}` : char;

const globRegex = (glob: string): RegExp => {
  let source = '';
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i];
    if (char === '*' && glob[i + 1] === '*') {
      const atStart = i === 0 || glob[i - 1] === '/';
      const atEnd = i + 2 === glob.length || glob[i + 2] === '/';
      if (atStart && atEnd) {
        if (glob[i + 2] === '/') {
          // `**/`: zero or more whole segments.
          source += '(?:[^/]+/)*';
          i += 2;
        } else {
          // A trailing `**`: everything below.
          source += '.*';
          i += 1;
        }
        continue;
      }
      // `**` inside a segment is a plain `*`.
      source += '[^/]*';
      i += 1;
      continue;
    }
    if (char === '*') source += '[^/]*';
    else if (char === '?') source += '[^/]';
    else source += escapeRegex(char);
  }
  return new RegExp(`^${source}$`);
};

/** Whether `path` matches `glob`. */
export const demoUiPathMatches = (glob: string, path: string): boolean =>
  globRegex(glob.trim()).test(path);

/** Whether any of `files` matches any of `globs`. */
export const touchesDemoUiPaths = (
  files: readonly string[],
  globs: readonly string[],
): boolean => {
  const regexes = globs
    .map((glob) => glob.trim())
    .filter((glob) => glob.length > 0)
    .map(globRegex);
  return files.some((file) => regexes.some((regex) => regex.test(file)));
};

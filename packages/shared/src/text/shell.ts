const SAFE_SHELL_WORD = /^[A-Za-z0-9._-]+$/;

/**
 * A value as one POSIX shell word: bare when it holds only safe characters,
 * else single-quoted with every `'` written as `'\''`. Inside single quotes
 * the shell expands nothing, so `$(…)`, backticks and `;` stay text.
 */
export const shellWord = (value: string): string =>
  SAFE_SHELL_WORD.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;

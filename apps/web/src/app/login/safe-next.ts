/** Where a signed-in user lands when there is no `next`. */
export const HOME_PATH = '/';

/**
 * The `?next=` path to go to after signing in, or `/`. Only a same-origin
 * path is accepted: it starts with exactly one `/`, so `//host`, `/\host`,
 * `https://host` and `javascript:` are refused (no open redirect). The proxy
 * builds `next` from the request path; this guards what comes back.
 */
export function safeNext(next: string | null | undefined): string {
  if (!next?.startsWith('/')) return HOME_PATH;
  const second = next.charAt(1);
  if (second === '/' || second === '\\') return HOME_PATH;
  // A control character (tab, newline) can be stripped by the URL parser
  // and turn `/\t/host` into `//host`.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: that is the point
  if (/[\u0000-\u001f\u007f]/.test(next)) return HOME_PATH;
  if (next === '/login' || next.startsWith('/login?')) return HOME_PATH;
  return next;
}

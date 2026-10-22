/** Where a signed-in user lands when there is no `next`. */
export const HOME_PATH = '/';

/**
 * The `?next=` path to go to after signing in, or `/`. Only a same-origin
 * path is accepted: it starts with exactly one `/`, so `//host`, `/\host`,
 * `https://host` and `javascript:` are refused (no open redirect). The proxy
 * builds `next` from the request path; this guards what comes back.
 * Only a page is a destination: an API route or a Next.js asset
 * (`/api/…`, `/_next/…`) would land the person on raw JSON or a file.
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
  if (!isPageRoute(next)) return HOME_PATH;
  return next;
}

/** Prefixes that are not pages: the API proxy and Next.js internals. */
const NON_PAGE_PREFIXES = ['/api', '/_next'];

/**
 * Whether `path` names a page. The path is resolved first, as the browser
 * would, so `/./api/x` or `/x/../api/x` cannot slip past the prefix check.
 */
function isPageRoute(path: string): boolean {
  let pathname: string;
  try {
    pathname = new URL(path, 'http://next.invalid').pathname;
  } catch {
    return false;
  }
  return !NON_PAGE_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

/**
 * Where `/login` sends a visitor who is already signed in: `?next=` when it
 * is safe, else `/`. Null — show the form — when nobody is signed in. `next`
 * is the raw search param, so a repeated `?next=` (an array) is refused.
 */
export function signedInRedirect(
  signedIn: boolean,
  next: string | string[] | undefined,
): string | null {
  if (!signedIn) return null;
  return safeNext(typeof next === 'string' ? next : null);
}

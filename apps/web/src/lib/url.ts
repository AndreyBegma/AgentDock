/**
 * The web app's one URL-safety module (spec 164): every link that came from
 * text a person, an agent, GitHub or a runner wrote passes here before it
 * becomes an `href`.
 */

/** Hosts a GitHub issue, pull request or docs link may point at. */
export const GITHUB_HOSTS: readonly string[] = ['github.com'];

/**
 * A backslash reads as `/` to a browser (`/\host` is protocol-relative), and
 * the URL parser drops tabs and newlines (`/\t/host` is `//host`): a link
 * carrying either is refused before it is parsed.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to refuse them
const UNSAFE_CHARACTERS = /[\\\u0000-\u001f\u007f]/;

/**
 * The same characters percent-encoded: the Markdown parser writes `/\host` as
 * `/%5Chost`, and a server that decodes a path before redirecting turns it back.
 * An in-app path never needs either.
 */
const ENCODED_UNSAFE = /%(5c|[01][0-9a-f]|7f)/i;

/** Server rendering has no `location`; a path resolves the same against any origin. */
const FALLBACK_ORIGIN = 'https://nautelle.invalid';

const currentOrigin = (): string =>
  typeof window === 'undefined' ? FALLBACK_ORIGIN : window.location.origin;

/**
 * An in-app link: `link` resolved against this origin stays on it. Returns
 * the path, query and fragment (`/projects/p1?open=2#x`), or `undefined` for
 * anything that leaves the app — `//host`, `/\host`, `javascript:`, another
 * origin.
 */
export function internalHref(
  link: string | null | undefined,
): string | undefined {
  if (!link || UNSAFE_CHARACTERS.test(link) || ENCODED_UNSAFE.test(link)) {
    return undefined;
  }
  const origin = currentOrigin();
  let url: URL;
  try {
    url = new URL(link, origin);
  } catch {
    return undefined;
  }
  if (url.origin !== origin) return undefined;
  return `${url.pathname}${url.search}${url.hash}`;
}

/**
 * An `https:` link out of the app, with no userinfo (`https://github.com@evil`)
 * and, when `hosts` is given, a hostname exactly one of them — a look-alike
 * such as `github.com.evil.example` is refused. Returns `url` or `null`.
 */
export function externalHttpsUrl(
  url: string | null | undefined,
  { hosts }: { hosts?: readonly string[] } = {},
): string | null {
  if (!url || UNSAFE_CHARACTERS.test(url)) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  if (parsed.username !== '' || parsed.password !== '') return null;
  if (hosts && !hosts.includes(parsed.hostname)) return null;
  return url;
}

/** `externalHttpsUrl` for a GitHub issue, pull request or docs link. */
export const githubUrl = (url: string | null | undefined): string | null =>
  externalHttpsUrl(url, { hosts: GITHUB_HOSTS });

/**
 * `scheme://userinfo@` — userinfo is anything up to the first `@` before a
 * path, space or quote. A scheme starts only where a scheme character does
 * not precede it, so a long run of letters is scanned once, not once per
 * letter (C-128: the runner's redactor runs this over whole patches).
 */
const URL_USERINFO = /(?<![a-z0-9+.-])([a-z][a-z0-9+.-]*:\/\/)[^\s/@'"<>]+@/gi;

export const USERINFO_MASK = '***';

/**
 * Masks the userinfo of every URL in `text` (`https://user:token@host` →
 * `https://***@host`). SSH-style `git@host:path` has no scheme and is left alone.
 */
export const redactUrlUserinfo = (text: string): string =>
  text.replace(URL_USERINFO, `$1${USERINFO_MASK}@`);

export interface StrippedUrl {
  url: string;
  /** True when userinfo, a query or a fragment was removed. */
  stripped: boolean;
}

/**
 * An origin URL as it is reported to the server: no `user:pass@`, query or
 * fragment. Anything that is not a `scheme://` URL (`git@host:o/r.git`) is
 * returned unchanged.
 */
export const stripUrlCredentials = (url: string): StrippedUrl => {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return { url, stripped: false };
  const hasUserinfo = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*@/i.test(url);
  const cut = url.search(/[?#]/);
  const stripped = hasUserinfo || cut !== -1;
  if (!stripped) return { url, stripped: false };
  const base = cut === -1 ? url : url.slice(0, cut);
  const scheme = base.match(/^[a-z][a-z0-9+.-]*:\/\//i)?.[0] ?? '';
  const rest = base.slice(scheme.length);
  const slash = rest.indexOf('/');
  const authority = slash === -1 ? rest : rest.slice(0, slash);
  const path = slash === -1 ? '' : rest.slice(slash);
  return {
    url: `${scheme}${authority.slice(authority.lastIndexOf('@') + 1)}${path}`,
    stripped: true,
  };
};

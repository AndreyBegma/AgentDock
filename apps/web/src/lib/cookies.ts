/**
 * The value of cookie `name` in a `document.cookie` string, or `undefined`.
 * A cookie whose value is not valid percent-encoding (a sibling subdomain can
 * plant one) reads as absent instead of throwing.
 */
export function readCookieFrom(
  cookie: string,
  name: string,
): string | undefined {
  for (const part of cookie.split('; ')) {
    const eq = part.indexOf('=');
    if (part.slice(0, eq) !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1));
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Reads the cookie at call time; `undefined` outside a browser. */
export function readCookie(name: string): string | undefined {
  if (typeof document === 'undefined') return undefined;
  return readCookieFrom(document.cookie, name);
}

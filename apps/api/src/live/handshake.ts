/**
 * The value of cookie `name` in a raw `Cookie` header, or null. The upgrade
 * request does not pass through Express, so `cookie-parser` never sees it.
 */
export const cookieFrom = (
  header: string | undefined,
  name: string,
): string | null => {
  if (!header) return null;
  for (const pair of header.split(';')) {
    const eq = pair.indexOf('=');
    if (eq < 0 || pair.slice(0, eq).trim() !== name) continue;
    const raw = pair.slice(eq + 1).trim();
    const value =
      raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
    try {
      return decodeURIComponent(value) || null;
    } catch {
      return null;
    }
  }
  return null;
};

/** Whether the `Origin` header names exactly `allowed` (scheme, host and port). */
export const originAllowed = (
  origin: string | undefined,
  allowed: string,
): boolean => {
  if (!origin) return false;
  try {
    return new URL(origin).origin === allowed;
  } catch {
    return false;
  }
};

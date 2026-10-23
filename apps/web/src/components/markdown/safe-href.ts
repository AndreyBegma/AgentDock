import { internalHref } from '../../lib/url';

const SAFE_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

/**
 * A link target from agent-written text is followed only when it is http(s),
 * mailto, an in-app path or a fragment — never `javascript:`, `data:` or a
 * protocol-relative `//host` / `/\host`, which reads like a path and leaves
 * the site (`internalHref`).
 */
export function safeHref(href: string | null | undefined): string | null {
  const value = href?.trim();
  if (!value) return null;
  if (value.startsWith('#')) return value;
  if (value.startsWith('/')) return internalHref(value) ?? null;
  try {
    return SAFE_PROTOCOLS.has(new URL(value).protocol) ? value : null;
  } catch {
    return null;
  }
}

/** Whether a safe target leaves the app (opens in a new tab). */
export const isExternal = (href: string): boolean =>
  !href.startsWith('/') && !href.startsWith('#');

/** The host an external link really goes to, shown on hover; none for mailto. */
export function externalHost(href: string): string | undefined {
  try {
    return new URL(href).host || undefined;
  } catch {
    return undefined;
  }
}

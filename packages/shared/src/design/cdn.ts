/**
 * The CDN allowlist of a mockup (docs/specs/223-design-stage.md D6,
 * ADR-0022). It is code, not configuration: adding a host is a change with
 * review. The validator checks URLs against it and the mockup endpoint's CSP
 * is built from it, so the two can never disagree.
 */

/** How a host's URLs carry a package version, if they do. */
export type CdnVersioning =
  /** `/ajax/libs/<name>/<version>/<file>` */
  | 'cdnjs'
  /** `/npm/<package>@<version>[/<file>]`, scoped packages included */
  | 'npm-path'
  /** `/<package>@<version>[/<file>]`, scoped packages included */
  | 'npm-root'
  /** `/<version>`: the Tailwind Play CDN */
  | 'path-version'
  /** Google Fonts: the API is not versioned */
  | 'none';

export interface CdnSource {
  host: string;
  /** Every allowed path starts with it; `/` for the whole host. */
  pathPrefix: string;
  versioning: CdnVersioning;
}

/** D6, in this order in the CSP. HTTPS only. */
export const DESIGN_CDN_ALLOWLIST: readonly CdnSource[] = [
  { host: 'cdnjs.cloudflare.com', pathPrefix: '/', versioning: 'cdnjs' },
  { host: 'cdn.jsdelivr.net', pathPrefix: '/npm/', versioning: 'npm-path' },
  { host: 'unpkg.com', pathPrefix: '/', versioning: 'npm-root' },
  { host: 'cdn.tailwindcss.com', pathPrefix: '/', versioning: 'path-version' },
  { host: 'fonts.googleapis.com', pathPrefix: '/', versioning: 'none' },
  { host: 'fonts.gstatic.com', pathPrefix: '/', versioning: 'none' },
];

/** The allowlist as CSP source expressions: `https://<host><prefix>`, `/` dropped. */
export const DESIGN_CDN_CSP_SOURCES: readonly string[] =
  DESIGN_CDN_ALLOWLIST.map(
    (s) => `https://${s.host}${s.pathPrefix === '/' ? '' : s.pathPrefix}`,
  );

/** An exact semantic version: `18.3.1`, `4.0.0-beta.2`. Never `18`, `^18`, `latest`. */
const EXACT_VERSION =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export const isExactVersion = (version: string): boolean =>
  EXACT_VERSION.test(version);

/** `<package>@<version>` at the start of `path` (no leading `/`), scoped or not. */
const npmSpecVersion = (path: string): string | null => {
  const match = /^((?:@[^/@]+\/)?[^/@]+)@([^/]+)/.exec(path);
  return match ? decodeURIComponent(match[2]) : null;
};

const versionOf = (source: CdnSource, pathname: string): string | null => {
  const rest = pathname.slice(source.pathPrefix.length);
  switch (source.versioning) {
    case 'cdnjs': {
      const match = /^ajax\/libs\/[^/]+\/([^/]+)\//.exec(rest);
      return match ? decodeURIComponent(match[1]) : null;
    }
    case 'npm-path':
    case 'npm-root':
      return npmSpecVersion(rest);
    case 'path-version': {
      const match = /^([^/]+)\/?$/.exec(rest);
      return match ? decodeURIComponent(match[1]) : null;
    }
    case 'none':
      return null;
  }
};

export type CdnUrlCheck =
  | { ok: true }
  | { ok: false; problem: 'host' | 'version'; detail: string };

/**
 * Whether an absolute (`https://…`) or protocol-relative (`//…`) URL may be
 * loaded by a mockup: an allowlisted host and path, over HTTPS, and — where
 * the host versions packages — an exact version.
 */
export const checkCdnUrl = (raw: string): CdnUrlCheck => {
  const text = raw.trim();
  let url: URL;
  try {
    url = new URL(text.startsWith('//') ? `https:${text}` : text);
  } catch {
    return { ok: false, problem: 'host', detail: `not a valid URL: ${text}` };
  }
  if (url.protocol !== 'https:') {
    return { ok: false, problem: 'host', detail: `not HTTPS: ${text}` };
  }
  if (url.username !== '' || url.password !== '' || url.port !== '') {
    return { ok: false, problem: 'host', detail: `not a plain host: ${text}` };
  }
  const source = DESIGN_CDN_ALLOWLIST.find(
    (s) => s.host === url.hostname && url.pathname.startsWith(s.pathPrefix),
  );
  if (!source) {
    return {
      ok: false,
      problem: 'host',
      detail: `${url.hostname}${url.pathname} is not on the CDN allowlist`,
    };
  }
  if (source.versioning === 'none') return { ok: true };
  const version = versionOf(source, url.pathname);
  if (version === null || !isExactVersion(version)) {
    return {
      ok: false,
      problem: 'version',
      detail: `${text} does not name an exact version (like react@18.3.1)`,
    };
  }
  return { ok: true };
};

/**
 * The CDN allowlist of a mockup (docs/specs/223-design-stage.md D6,
 * ADR-0022). It is code, not configuration: adding a host or a package is a
 * change with review. The validator checks URLs against it and the mockup
 * endpoint's CSP is built from it, so the two can never disagree.
 */

/** How a host's URLs carry a package version, if they do. */
export type CdnVersioning =
  /** `/ajax/libs/<name>/<version>/<file>` */
  | 'cdnjs'
  /** `/npm/<package>@<version>/<file>`, scoped packages included */
  | 'npm-path'
  /** `/<package>@<version>/<file>`, scoped packages included */
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

export interface CdnPackage {
  name: string;
  /** Exact; a published npm version never changes, so its files cannot either. */
  version: string;
}

/**
 * The only packages the npm CDNs (`npm-path`, `npm-root`) may serve to a
 * mockup, each at one exact version (C-168). Anyone can publish to npm, so a
 * bare `cdn.jsdelivr.net/npm/` or `unpkg.com` source would run any package's
 * code in the frame; the CSP lists `<host><prefix><name>@<version>/` per entry
 * instead. The set covers what UI profiles and mockups reach for: a component
 * framework, icons, a CSS kit and charts.
 */
export const DESIGN_CDN_PACKAGES: readonly CdnPackage[] = [
  { name: 'react', version: '18.3.1' },
  { name: 'react-dom', version: '18.3.1' },
  { name: '@babel/standalone', version: '7.26.4' },
  { name: 'vue', version: '3.5.13' },
  { name: 'alpinejs', version: '3.14.8' },
  { name: 'htmx.org', version: '2.0.3' },
  { name: 'lucide', version: '0.460.0' },
  { name: 'bootstrap', version: '5.3.3' },
  { name: 'bootstrap-icons', version: '1.11.3' },
  { name: '@picocss/pico', version: '2.0.6' },
  { name: 'daisyui', version: '4.12.14' },
  { name: '@radix-ui/themes', version: '3.1.4' },
  { name: 'chart.js', version: '4.4.6' },
];

/** D6, in this order in the CSP. HTTPS only. */
export const DESIGN_CDN_ALLOWLIST: readonly CdnSource[] = [
  { host: 'cdnjs.cloudflare.com', pathPrefix: '/', versioning: 'cdnjs' },
  { host: 'cdn.jsdelivr.net', pathPrefix: '/npm/', versioning: 'npm-path' },
  { host: 'unpkg.com', pathPrefix: '/', versioning: 'npm-root' },
  { host: 'cdn.tailwindcss.com', pathPrefix: '/', versioning: 'path-version' },
  { host: 'fonts.googleapis.com', pathPrefix: '/', versioning: 'none' },
  { host: 'fonts.gstatic.com', pathPrefix: '/', versioning: 'none' },
];

/** Whether a source serves arbitrary npm packages, so only `DESIGN_CDN_PACKAGES` of it are allowed. */
export const isNpmCdnSource = (source: CdnSource): boolean =>
  source.versioning === 'npm-path' || source.versioning === 'npm-root';

/** `<name>@<version>/`: the directory of one package version on an npm CDN. */
export const cdnPackagePath = (pkg: CdnPackage): string =>
  `${pkg.name}@${pkg.version}/`;

/**
 * The allowlist as CSP source expressions: `https://<host><prefix>` with `/`
 * dropped, and for an npm CDN one `https://<host><prefix><name>@<version>/`
 * per package — a path ending in `/` matches the files under it only.
 */
export const DESIGN_CDN_CSP_SOURCES: readonly string[] =
  DESIGN_CDN_ALLOWLIST.flatMap((s) =>
    isNpmCdnSource(s)
      ? DESIGN_CDN_PACKAGES.map(
          (p) => `https://${s.host}${s.pathPrefix}${cdnPackagePath(p)}`,
        )
      : [`https://${s.host}${s.pathPrefix === '/' ? '' : s.pathPrefix}`],
  );

/** An exact semantic version: `18.3.1`, `4.0.0-beta.2`. Never `18`, `^18`, `latest`. */
const EXACT_VERSION =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export const isExactVersion = (version: string): boolean =>
  EXACT_VERSION.test(version);

/** The version of `<package>@<version>` at the start of `path` (no leading `/`), scoped or not. */
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
 * loaded by a mockup: an allowlisted host and path over HTTPS; where the host
 * versions packages, an exact version; and on an npm CDN, a file of an
 * allowlisted package at its listed version.
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
  return isNpmCdnSource(source)
    ? checkNpmPackage(url.pathname.slice(source.pathPrefix.length), text)
    : { ok: true };
};

const ALLOWED_PACKAGES = DESIGN_CDN_PACKAGES.map(
  (p) => `${p.name}@${p.version}`,
).join(', ');

/**
 * An npm CDN path (after the source's prefix) names a file of one of
 * `DESIGN_CDN_PACKAGES` — the same `<name>@<version>/` prefixes the CSP lists,
 * so a URL the validator accepts is one the browser loads.
 */
const checkNpmPackage = (rest: string, text: string): CdnUrlCheck => {
  const pkg = DESIGN_CDN_PACKAGES.find((p) =>
    rest.startsWith(cdnPackagePath(p)),
  );
  if (!pkg) {
    return {
      ok: false,
      problem: 'host',
      detail: `${text} is not a package on the CDN allowlist; use one of ${ALLOWED_PACKAGES}, or inline the code`,
    };
  }
  if (rest.length === cdnPackagePath(pkg).length) {
    return {
      ok: false,
      problem: 'host',
      detail: `${text} names no file; give its path, like ${cdnPackagePath(pkg)}dist/…`,
    };
  }
  return { ok: true };
};

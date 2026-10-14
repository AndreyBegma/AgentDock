import { DESIGN_CDN_CSP_SOURCES } from './cdn';

/**
 * The headers of the mockup endpoint `GET /design-revisions/:id/html`
 * (docs/specs/223-design-stage.md "API", D6). They override helmet's
 * defaults for that route only.
 *
 * `sandbox allow-scripts` without `allow-same-origin` gives the document an
 * opaque origin even when it is served from AgentDock's own origin: no
 * cookies, no storage, no API. `connect-src 'none'` stops every network call
 * a script could make; the CDN allowlist is the only place code and styles
 * come from.
 */
export const buildMockupCsp = (): string => {
  const cdn = DESIGN_CDN_CSP_SOURCES.join(' ');
  return [
    'sandbox allow-scripts',
    "default-src 'none'",
    `script-src 'unsafe-inline' ${cdn}`,
    `style-src 'unsafe-inline' ${cdn}`,
    `font-src ${cdn} data:`,
    `img-src ${cdn} data:`,
    "connect-src 'none'",
    "form-action 'none'",
    "frame-ancestors 'self'",
  ].join('; ');
};

/** Every header the mockup endpoint sets, `Content-Type` included. */
export const MOCKUP_RESPONSE_HEADERS: Readonly<Record<string, string>> = {
  'Content-Type': 'text/html; charset=utf-8',
  'Content-Security-Policy': buildMockupCsp(),
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

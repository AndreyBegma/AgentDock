import {
  injectPinHelper,
  MOCKUP_RESPONSE_HEADERS,
  type UiProfileSnippet,
} from '@agentdock/shared';
import type { Response } from 'express';

/**
 * How every mockup document leaves the API (docs/specs/223-design-stage.md
 * "API", D6, D9): `MOCKUP_RESPONSE_HEADERS` over helmet's for this response
 * only — `sandbox allow-scripts` gives the document an opaque origin, so its
 * script reads no cookie, no storage and no API of Nautelle, and
 * `connect-src 'none'` stops every network call — with the pin helper
 * injected. The helper is never stored. The revision endpoint and the
 * profile preview both answer through here.
 */
export const sendMockup = (res: Response, html: string): void => {
  res.status(200);
  for (const [name, value] of Object.entries(MOCKUP_RESPONSE_HEADERS)) {
    res.setHeader(name, value);
  }
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(injectPinHelper(html));
};

const escapeHtml = (text: string): string =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/**
 * Settings → Design's preview of a profile version: its kit and every
 * snippet on one page, as a mockup would use them. The kit cannot close its
 * own `<style>`.
 */
export const profilePreviewHtml = (profile: {
  version: number;
  kit: string;
  snippets: readonly UiProfileSnippet[];
}): string =>
  [
    '<!doctype html>',
    '<html lang="en" data-theme="light">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>UI profile v${profile.version}</title>`,
    `<style>${profile.kit.replace(/<\/style/gi, '<\\/style')}</style>`,
    '<style>[data-agentdock-snippet]{margin:0 0 32px}[data-agentdock-snippet]>h2{font:600 12px/1.4 system-ui,sans-serif;opacity:.6;margin:0 0 8px}</style>',
    '</head>',
    '<body>',
    '<main>',
    ...(profile.snippets.length > 0
      ? profile.snippets.map(
          (s) =>
            `<section data-agentdock-snippet><h2>${escapeHtml(s.name)}</h2>${s.html}</section>`,
        )
      : ['<p>This profile has no snippets.</p>']),
    '</main>',
    '</body>',
    '</html>',
  ].join('\n');

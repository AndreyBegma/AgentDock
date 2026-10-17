import { checkCdnUrl } from './cdn';
import { DESIGN_HTML_MAX_BYTES, designBytes } from './limits';

/**
 * The mockup validator (docs/specs/223-design-stage.md D6). A design turn
 * whose HTML breaks a rule fails as `contract_violation` with the reason, and
 * no revision is stored.
 *
 * This is a lint over the text, not an HTML parser, and a script can still
 * build a URL at run time. The enforcement is the mockup endpoint's CSP
 * (`./csp.ts`) and the sandbox; the validator exists so the planner gets a
 * reason it can act on instead of a mockup that silently fails to load.
 */

export const MOCKUP_VIOLATION_REASONS = [
  /** Over `DESIGN_HTML_MAX_BYTES` (D7). */
  'design_too_large',
  /** A resource from a host that is not on the CDN allowlist, or a relative URL. */
  'design_host_not_allowed',
  /** A CDN package URL without an exact version (`react@18`, `latest`). */
  'design_unpinned_version',
  /** Network calls, a form that submits, top navigation, frames, `<base>`. */
  'design_forbidden_feature',
] as const;
export type MockupViolationReason = (typeof MOCKUP_VIOLATION_REASONS)[number];

export type MockupValidation =
  | { ok: true }
  | { ok: false; reason: MockupViolationReason; message: string };

export interface MockupValidateOptions {
  /** Default `DESIGN_HTML_MAX_BYTES`; a profile's kit and snippets pass their own. */
  maxBytes?: number;
}

const fail = (
  reason: MockupViolationReason,
  message: string,
): MockupValidation => ({ ok: false, reason, message });

const SNIPPET_MAX = 120;
const excerpt = (text: string): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > SNIPPET_MAX ? `${flat.slice(0, SNIPPET_MAX)}…` : flat;
};

/** Script that may reach the network, submit, or leave the frame. */
const FORBIDDEN_SCRIPT: readonly { pattern: RegExp; what: string }[] = [
  { pattern: /\bfetch\s*\(/, what: 'fetch()' },
  { pattern: /\bXMLHttpRequest\b/, what: 'XMLHttpRequest' },
  { pattern: /\bWebSocket\b/, what: 'WebSocket' },
  { pattern: /\bEventSource\b/, what: 'EventSource' },
  { pattern: /\bsendBeacon\b/, what: 'navigator.sendBeacon' },
  { pattern: /\.\s*(?:requestSubmit|submit)\s*\(/, what: 'a form submit' },
  { pattern: /\bwindow\s*\.\s*open\s*\(/, what: 'window.open' },
  { pattern: /\bopener\b/, what: 'window.opener' },
  {
    pattern: /\b(?:top|parent)\s*\.\s*(?:location|postMessage)\b/,
    what: 'top or parent navigation or messaging',
  },
  { pattern: /\bwindow\s*\.\s*(?:top|parent)\b/, what: 'window.top/parent' },
  // Tripwire, not a wall: the viewer also resets a frame that loads twice.
  {
    pattern: /\b(?:self|window|document|globalThis|this)\s*\.\s*location\b/,
    what: 'location (navigates the frame)',
  },
  {
    pattern:
      /(?<![\w$])(?<!\b(?:const|let|var)\s)location\s*(?:\.\s*(?:assign|replace|href)\b|=(?![=>]))/,
    what: 'location (navigates the frame)',
  },
];

const findForbiddenScript = (code: string): string | null =>
  FORBIDDEN_SCRIPT.find((f) => f.pattern.test(code))?.what ?? null;

interface Tag {
  name: string;
  attrs: Map<string, string>;
  raw: string;
}

const TAG =
  /<([a-zA-Z][\w:-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*\/?>/g;
const ATTR = /([^\s=>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

const decodeEntities = (value: string): string =>
  value
    .replace(/&#x([0-9a-f]+);?/gi, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);?/g, (_, dec: string) =>
      String.fromCodePoint(Number.parseInt(dec, 10)),
    )
    .replace(/&colon;/gi, ':')
    .replace(/&sol;/gi, '/')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&amp;/gi, '&');

const parseTags = (html: string): Tag[] => {
  const tags: Tag[] = [];
  for (const match of html.matchAll(TAG)) {
    const attrs = new Map<string, string>();
    for (const a of (match[2] ?? '').matchAll(ATTR)) {
      const value = a[2] ?? a[3] ?? a[4] ?? '';
      attrs.set(a[1].toLowerCase(), decodeEntities(value));
    }
    tags.push({ name: match[1].toLowerCase(), attrs, raw: match[0] });
  }
  return tags;
};

/** The bodies of every `<tag>…</tag>`, case-insensitive. */
const bodiesOf = (html: string, tag: string): string[] =>
  [
    ...html.matchAll(
      new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)(?:</${tag}\\s*>|$)`, 'gi'),
    ),
  ].map((m) => m[1] ?? '');

/**
 * A resource's kind decides whether `data:` is allowed: CSP `img-src` and
 * `font-src` take `data:`, `script-src` and `style-src` do not.
 */
type UrlKind = 'code' | 'media';

/** `@import` targets (code) and `url(…)` targets (media) of a stylesheet. */
const cssUrls = (css: string): { url: string; kind: UrlKind }[] => {
  const urls: { url: string; kind: UrlKind }[] = [];
  const imports =
    /@import\s+(?:url\(\s*)?(?:"([^"]*)"|'([^']*)'|([^)\s;]+))\s*\)?/gi;
  for (const m of css.matchAll(imports)) {
    urls.push({ url: m[1] ?? m[2] ?? m[3] ?? '', kind: 'code' });
  }
  const withoutImports = css.replace(imports, '');
  const refs = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)/gi;
  for (const m of withoutImports.matchAll(refs)) {
    urls.push({ url: m[1] ?? m[2] ?? m[3] ?? '', kind: 'media' });
  }
  return urls;
};

const checkResourceUrl = (
  raw: string,
  kind: UrlKind,
  where: string,
): MockupValidation => {
  const url = raw.trim();
  if (url === '' || url.startsWith('#')) return { ok: true };
  if (/^data:/i.test(url)) {
    return kind === 'media'
      ? { ok: true }
      : fail(
          'design_host_not_allowed',
          `${where}: a data: URL is allowed only for images and fonts`,
        );
  }
  if (/^(?:https?:)?\/\//i.test(url)) {
    const check = checkCdnUrl(url);
    if (check.ok) return check;
    return fail(
      check.problem === 'host'
        ? 'design_host_not_allowed'
        : 'design_unpinned_version',
      `${where}: ${check.detail}`,
    );
  }
  return fail(
    'design_host_not_allowed',
    `${where}: ${excerpt(url)} is not on the CDN allowlist — a mockup is self-contained; inline it, use a data: URL, or an allowlisted CDN`,
  );
};

/** Tags whose `href` loads a resource rather than navigating. */
const RESOURCE_HREF_TAGS = new Set(['link', 'image', 'use', 'feimage']);
const NAVIGATION_TAGS = new Set(['a', 'area']);
const EMBED_TAGS = new Set([
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'portal',
]);

const checkTag = (tag: Tag): MockupValidation => {
  const where = `<${tag.name}> (${excerpt(tag.raw)})`;
  const forbidden = (what: string) =>
    fail('design_forbidden_feature', `${what}: ${excerpt(tag.raw)}`);

  if (tag.name === 'base') return forbidden('<base> changes where URLs go');
  if (EMBED_TAGS.has(tag.name)) {
    return forbidden(`<${tag.name}> embeds another document`);
  }
  if (
    tag.name === 'meta' &&
    tag.attrs.get('http-equiv')?.trim().toLowerCase() === 'refresh'
  ) {
    return forbidden('<meta http-equiv="refresh"> navigates');
  }
  if (
    tag.name === 'form' &&
    (tag.attrs.has('action') || tag.attrs.has('method'))
  ) {
    return forbidden('a form that submits');
  }
  if (tag.attrs.has('formaction')) return forbidden('a form that submits');
  const target = tag.attrs.get('target')?.trim().toLowerCase();
  if (target === '_top' || target === '_parent') {
    return forbidden('top navigation');
  }

  for (const [name, value] of tag.attrs) {
    if (name.startsWith('on')) {
      const what = findForbiddenScript(value);
      if (what) return forbidden(what);
    }
    if (/^\s*javascript:/i.test(value)) {
      const what = findForbiddenScript(value);
      if (what) return forbidden(what);
    }
  }

  const style = tag.attrs.get('style');
  if (style !== undefined) {
    for (const { url, kind } of cssUrls(style)) {
      const check = checkResourceUrl(url, kind, where);
      if (!check.ok) return check;
    }
  }

  const href = tag.attrs.get('href') ?? tag.attrs.get('xlink:href');
  if (href !== undefined) {
    if (NAVIGATION_TAGS.has(tag.name)) {
      if (/^\s*(?:https?:)?\/\//i.test(href)) {
        return forbidden('a link that navigates away from the mockup');
      }
    } else if (RESOURCE_HREF_TAGS.has(tag.name)) {
      const rel = tag.attrs.get('rel')?.toLowerCase() ?? '';
      const as = tag.attrs.get('as')?.toLowerCase();
      const kind: UrlKind =
        tag.name !== 'link' ||
        /\bicon\b/.test(rel) ||
        as === 'font' ||
        as === 'image'
          ? 'media'
          : 'code';
      const check = checkResourceUrl(href, kind, where);
      if (!check.ok) return check;
    }
  }

  const src = tag.attrs.get('src');
  if (src !== undefined) {
    const kind: UrlKind = tag.name === 'script' ? 'code' : 'media';
    const check = checkResourceUrl(src, kind, where);
    if (!check.ok) return check;
  }
  for (const name of ['poster', 'background']) {
    const value = tag.attrs.get(name);
    if (value === undefined) continue;
    const check = checkResourceUrl(value, 'media', where);
    if (!check.ok) return check;
  }
  const srcset = tag.attrs.get('srcset');
  if (srcset !== undefined) {
    for (const candidate of srcset.split(',')) {
      const url = candidate.trim().split(/\s+/)[0] ?? '';
      const check = checkResourceUrl(url, 'media', where);
      if (!check.ok) return check;
    }
  }
  return { ok: true };
};

/**
 * Validates one mockup (or a profile's kit or snippet) against D6. The first
 * broken rule is the answer: size, then script, then tags in document order,
 * then stylesheets.
 */
export const validateMockup = (
  html: string,
  options: MockupValidateOptions = {},
): MockupValidation => {
  const maxBytes = options.maxBytes ?? DESIGN_HTML_MAX_BYTES;
  const size = designBytes(html);
  if (size > maxBytes) {
    return fail(
      'design_too_large',
      `the mockup is ${size} bytes; at most ${maxBytes} — split the screen or move styling to an allowlisted CDN`,
    );
  }

  // Comments are not markup, so a URL quoted in one loads nothing.
  const text = html.replace(/<!--[\s\S]*?(?:-->|$)/g, '');

  for (const script of bodiesOf(text, 'script')) {
    const what = findForbiddenScript(script);
    if (what) {
      return fail(
        'design_forbidden_feature',
        `${what} in a script — a mockup makes no network calls and stays in its frame`,
      );
    }
  }

  // Script bodies are code, not tags: `'<a href=…>'` in a string is still checked.
  for (const tag of parseTags(text)) {
    const check = checkTag(tag);
    if (!check.ok) return check;
  }

  for (const css of bodiesOf(text, 'style')) {
    for (const { url, kind } of cssUrls(css)) {
      const check = checkResourceUrl(url, kind, '<style>');
      if (!check.ok) return check;
    }
  }
  return { ok: true };
};

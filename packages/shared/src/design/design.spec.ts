import { describe, expect, it } from 'bun:test';
import { runLogLinesFrameSchema } from '../protocol/pane';
import {
  buildMockupCsp,
  checkCdnUrl,
  DESIGN_CDN_ALLOWLIST,
  DESIGN_HTML_MAX_BYTES,
  designFailureReasonOf,
  fingerprintGlobSchema,
  injectPinHelper,
  MOCKUP_PIN_HELPER_ATTRIBUTE,
  MOCKUP_RESPONSE_HEADERS,
  mockupMessageSchema,
  parseUiProfileOutput,
  STALL_AFTER_MS,
  UI_PROFILE_KIT_MAX_BYTES,
  validateMockup,
  viewerMessageSchema,
  viewportPresetsSchema,
} from './index';

const doc = (head: string, body = '<main>Hi</main>') =>
  `<!doctype html><html lang="en" data-theme="light"><head>${head}</head><body>${body}</body></html>`;

describe('checkCdnUrl', () => {
  it.each([
    'https://cdnjs.cloudflare.com/ajax/libs/react/18.3.1/umd/react.production.min.js',
    'https://cdn.jsdelivr.net/npm/react@18.3.1/umd/react.production.min.js',
    'https://cdn.jsdelivr.net/npm/@radix-ui/themes@3.1.4/styles.css',
    'https://unpkg.com/lucide@0.460.0',
    'https://unpkg.com/@picocss/pico@2.0.6/css/pico.min.css',
    'https://cdn.tailwindcss.com/3.4.16',
    'https://cdn.tailwindcss.com/3.4.16?plugins=forms',
    'https://fonts.googleapis.com/css2?family=Inter:wght@400;600',
    'https://fonts.gstatic.com/s/inter/v13/abc.woff2',
    '//unpkg.com/htmx.org@2.0.3',
    'https://cdn.jsdelivr.net/npm/daisyui@5.0.0-beta.1/daisyui.css',
  ])('allows %s', (url) => {
    expect(checkCdnUrl(url)).toEqual({ ok: true });
  });

  it.each([
    ['https://evil.example/x.js', 'host'],
    ['http://unpkg.com/react@18.3.1', 'host'],
    ['https://cdn.jsdelivr.net/gh/user/repo@1.0.0/x.js', 'host'],
    ['https://unpkg.com:8443/react@18.3.1', 'host'],
    ['https://unpkg.com.evil.example/react@18.3.1', 'host'],
    ['https://unpkg.com/react@18', 'version'],
    ['https://unpkg.com/react', 'version'],
    ['https://cdn.jsdelivr.net/npm/react@latest/index.js', 'version'],
    ['https://cdn.jsdelivr.net/npm/react@^18.3.1/index.js', 'version'],
    ['https://cdnjs.cloudflare.com/ajax/libs/react/18/react.js', 'version'],
    ['https://cdn.tailwindcss.com', 'version'],
    ['https://cdn.tailwindcss.com/3.4', 'version'],
  ] as const)('refuses %s (%s)', (url, problem) => {
    const check = checkCdnUrl(url);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.problem).toBe(problem);
  });
});

describe('validateMockup', () => {
  it('accepts a self-contained mockup with pinned CDN code, inline script and data: images', () => {
    const html = doc(
      '<script src="https://cdn.tailwindcss.com/3.4.16"></script>' +
        '<link rel="preconnect" href="https://fonts.googleapis.com">' +
        '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter">' +
        '<style>:root[data-theme="dark"]{--bg:#000} .x{background:url(data:image/png;base64,AAAA)}</style>',
      '<a href="#top">top</a><img src="data:image/svg+xml,<svg/>" alt="">' +
        '<form onsubmit="return false"><button type="button" onclick="this.textContent=\'ok\'">Go</button></form>' +
        '<script>document.querySelector("main").dataset.ready = "1"</script>',
    );
    expect(validateMockup(html)).toEqual({ ok: true });
  });

  it('refuses a mockup over the size limit', () => {
    const html = doc('', 'x'.repeat(DESIGN_HTML_MAX_BYTES));
    const check = validateMockup(html);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toBe('design_too_large');
  });

  it.each([
    [
      '<script src="https://evil.example/x.js"></script>',
      'design_host_not_allowed',
    ],
    ['<script src="app.js"></script>', 'design_host_not_allowed'],
    [
      '<script src="data:text/javascript,alert(1)"></script>',
      'design_host_not_allowed',
    ],
    [
      '<link rel="stylesheet" href="https://evil.example/a.css">',
      'design_host_not_allowed',
    ],
    ['<img src="https://images.example/a.png">', 'design_host_not_allowed'],
    [
      '<img srcset="data:image/png;base64,AA 1x, https://x.example/b.png 2x">',
      'design_host_not_allowed',
    ],
    [
      '<div style="background:url(https://x.example/b.png)"></div>',
      'design_host_not_allowed',
    ],
    [
      '<style>@import url("https://evil.example/a.css");</style>',
      'design_host_not_allowed',
    ],
    [
      '<style>@import "https://unpkg.com/x@1/a.css";</style>',
      'design_unpinned_version',
    ],
    [
      '<script src="https://unpkg.com/react@18/umd/react.js"></script>',
      'design_unpinned_version',
    ],
    [
      '<script src="https://cdn.jsdelivr.net/npm/vue@latest"></script>',
      'design_unpinned_version',
    ],
    ['<script>fetch("/api/me")</script>', 'design_forbidden_feature'],
    ['<script>new XMLHttpRequest()</script>', 'design_forbidden_feature'],
    ['<script>new WebSocket("wss://x")</script>', 'design_forbidden_feature'],
    ['<script>navigator.sendBeacon("/x")</script>', 'design_forbidden_feature'],
    ['<script>top.location = "https://x"</script>', 'design_forbidden_feature'],
    [
      '<script>window.parent.postMessage({}, "*")</script>',
      'design_forbidden_feature',
    ],
    ['<script>window.open("https://x")</script>', 'design_forbidden_feature'],
    [
      '<script>location.assign("https://x")</script>',
      'design_forbidden_feature',
    ],
    [
      '<script>location.replace("https://x")</script>',
      'design_forbidden_feature',
    ],
    ['<script>location.href="https://x"</script>', 'design_forbidden_feature'],
    ['<script>location = "https://x"</script>', 'design_forbidden_feature'],
    ['<script>self.location="https://x"</script>', 'design_forbidden_feature'],
    [
      '<script>window.location.href = "/x"</script>',
      'design_forbidden_feature',
    ],
    [
      '<button onclick="location.href=\'/x\'">x</button>',
      'design_forbidden_feature',
    ],
    ['<script>document.forms[0].submit()</script>', 'design_forbidden_feature'],
    ['<button onclick="fetch(\'/x\')">x</button>', 'design_forbidden_feature'],
    [
      '<form action="https://x.example/post"><button>Go</button></form>',
      'design_forbidden_feature',
    ],
    ['<form method="post"></form>', 'design_forbidden_feature'],
    ['<a href="https://phish.example">log in</a>', 'design_forbidden_feature'],
    ['<a href="#x" target="_top">x</a>', 'design_forbidden_feature'],
    [
      '<meta http-equiv="refresh" content="0;url=https://x">',
      'design_forbidden_feature',
    ],
    ['<base href="https://x.example/">', 'design_forbidden_feature'],
    ['<iframe src="https://x.example"></iframe>', 'design_forbidden_feature'],
    ['<object data="x.swf"></object>', 'design_forbidden_feature'],
  ] as const)('refuses %s', (fragment, reason) => {
    const check = validateMockup(doc('', fragment));
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toBe(reason);
  });

  it('decodes entities in attributes before checking them', () => {
    const check = validateMockup(
      doc('', '<script src="https&#58;//evil.example/x.js"></script>'),
    );
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toBe('design_host_not_allowed');
  });

  it('does not mistake a local named location for navigation', () => {
    const html = doc(
      '',
      '<script>const location = "Berlin"; if (location == "x") {}</script>',
    );
    expect(validateMockup(html)).toEqual({ ok: true });
  });

  it('ignores URLs inside HTML comments and words in text', () => {
    const html = doc(
      '<!-- <script src="https://evil.example/x.js"></script> -->',
      '<p>We fetch(data) every hour</p>',
    );
    expect(validateMockup(html)).toEqual({ ok: true });
  });
});

describe('buildMockupCsp', () => {
  it('is the spec header, built from the allowlist', () => {
    const cdn =
      'https://cdnjs.cloudflare.com https://cdn.jsdelivr.net/npm/ https://unpkg.com https://cdn.tailwindcss.com https://fonts.googleapis.com https://fonts.gstatic.com';
    expect(buildMockupCsp()).toBe(
      `sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' ${cdn}; style-src 'unsafe-inline' ${cdn}; font-src ${cdn} data:; img-src ${cdn} data:; connect-src 'none'; form-action 'none'; frame-ancestors 'self'`,
    );
    expect(DESIGN_CDN_ALLOWLIST).toHaveLength(6);
  });

  it('never grants same-origin, and blocks every network call', () => {
    const csp = MOCKUP_RESPONSE_HEADERS['Content-Security-Policy'];
    expect(csp).not.toContain('allow-same-origin');
    expect(csp).toContain("connect-src 'none'");
    expect(MOCKUP_RESPONSE_HEADERS['X-Content-Type-Options']).toBe('nosniff');
    expect(MOCKUP_RESPONSE_HEADERS['Referrer-Policy']).toBe('no-referrer');
  });
});

describe('the pin helper', () => {
  it('goes before the last </body>, or at the end', () => {
    const served = injectPinHelper(doc(''));
    expect(served).toContain(`<script ${MOCKUP_PIN_HELPER_ATTRIBUTE}>`);
    expect(served.indexOf(MOCKUP_PIN_HELPER_ATTRIBUTE)).toBeLessThan(
      served.lastIndexOf('</body>'),
    );
    expect(injectPinHelper('<p>x</p>').endsWith('</script>')).toBe(true);
  });

  it('parses the messages of both sides, and nothing else', () => {
    expect(
      mockupMessageSchema.safeParse({
        source: 'agentdock-mockup',
        type: 'pin',
        x: 10,
        y: 2400,
        selector: 'main:nth-of-type(1) > button:nth-of-type(2)',
      }).success,
    ).toBe(true);
    expect(
      viewerMessageSchema.safeParse({
        source: 'agentdock-viewer',
        type: 'theme',
        theme: 'dark',
      }).success,
    ).toBe(true);
    expect(
      mockupMessageSchema.safeParse({
        source: 'agentdock-viewer',
        type: 'ready',
      }).success,
    ).toBe(false);
    expect(
      viewerMessageSchema.safeParse({
        source: 'agentdock-viewer',
        type: 'theme',
        theme: 'sepia',
      }).success,
    ).toBe(false);
  });
});

describe('viewport presets and fingerprint globs', () => {
  it('refuses duplicate preset names', () => {
    expect(
      viewportPresetsSchema.safeParse([
        { name: 'Mobile', width: 390, height: 844 },
        { name: 'Mobile', width: 390, height: 844, theme: 'dark' },
      ]).success,
    ).toBe(false);
  });

  it.each([
    '../secrets/**',
    '/etc/passwd',
    'src/../../x',
    'C:/x',
    'a\\b',
  ])('refuses the glob %s', (glob) => {
    expect(fingerprintGlobSchema.safeParse(glob).success).toBe(false);
  });

  it.each([
    'src/theme/**/*.ts',
    'tailwind.config.*',
    'apps/web/src/app/globals.css',
  ])('accepts the glob %s', (glob) => {
    expect(fingerprintGlobSchema.safeParse(glob).success).toBe(true);
  });
});

describe('parseUiProfileOutput', () => {
  const profile = {
    action: 'profile',
    hasUi: true,
    summary: '## Libraries\n- glass-ui 1.4.0',
    kit: ':root[data-theme="light"]{--bg:#fff}',
    snippets: [{ name: 'button', html: '<button class="btn">Save</button>' }],
    fingerprintGlobs: ['apps/web/src/app/globals.css'],
  };
  const block = (value: unknown) =>
    `Done.\n\n\`\`\`agentdock-plan\n${JSON.stringify(value)}\n\`\`\`\n`;

  it('accepts a profile', () => {
    const parsed = parseUiProfileOutput(block(profile));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.output.snippets[0].name).toBe('button');
  });

  it.each([
    ['no block', 'nothing here', 'no_block'],
    ['an unknown key', block({ ...profile, extra: 1 }), 'unknown_key'],
    [
      'another action',
      block({ ...profile, action: 'design' }),
      'action_mismatch',
    ],
    [
      'a glob with ..',
      block({ ...profile, fingerprintGlobs: ['../x'] }),
      'invalid_shape',
    ],
    [
      'a kit over the limit',
      block({ ...profile, kit: 'a'.repeat(UI_PROFILE_KIT_MAX_BYTES + 1) }),
      'kit_too_large',
    ],
    [
      'a kit importing from another host',
      block({ ...profile, kit: '@import url("https://evil.example/a.css");' }),
      'design_host_not_allowed',
    ],
    [
      'a snippet that fetches',
      block({
        ...profile,
        snippets: [{ name: 'x', html: '<script>fetch("/x")</script>' }],
      }),
      'design_forbidden_feature',
    ],
  ] as const)('refuses %s', (_, text, reason) => {
    const parsed = parseUiProfileOutput(text);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.reason).toBe(reason);
  });
});

describe('designFailureReasonOf (#275 D6)', () => {
  it('reads the runner timeout sentence as timed_out', () => {
    expect(designFailureReasonOf('the turn exceeded its 1200 s timeout')).toBe(
      'timed_out',
    );
  });

  it('reads any other error, or none, as failed', () => {
    expect(
      designFailureReasonOf('the session ended without an exit status'),
    ).toBe('failed');
    expect(designFailureReasonOf('timeout talking to GitHub')).toBe('failed');
    expect(designFailureReasonOf(null)).toBe('failed');
  });

  it('reads a cancelled turn or an abandoned build as stopped', () => {
    expect(
      designFailureReasonOf('the turn exceeded its 1200 s timeout', true),
    ).toBe('stopped');
    expect(designFailureReasonOf(null, true)).toBe('stopped');
  });

  it('keeps the stall threshold at 5 minutes', () => {
    expect(STALL_AFTER_MS).toBe(5 * 60 * 1000);
  });
});

describe('run_log lines frame (#275 D4)', () => {
  const frame = { type: 'lines', backlog: true, lines: [] };

  it('parses with and without lastOutputAt', () => {
    expect(runLogLinesFrameSchema.safeParse(frame).success).toBe(true);
    const parsed = runLogLinesFrameSchema.safeParse({
      ...frame,
      lastOutputAt: '2026-10-15T10:00:00.000Z',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.lastOutputAt).toBe('2026-10-15T10:00:00.000Z');
    }
  });

  it('refuses a lastOutputAt that is not an ISO time', () => {
    expect(
      runLogLinesFrameSchema.safeParse({ ...frame, lastOutputAt: 'yesterday' })
        .success,
    ).toBe(false);
  });
});

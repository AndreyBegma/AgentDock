/** Request header the proxy hands the per-request nonce to the layout in. */
export const NONCE_HEADER = 'x-nonce';

const DEFAULT_LIVE_URL = 'ws://localhost:8180/live';

/** #580: where Telegram's Web App script comes from; allowed on the Mini App's entry only. */
export const TELEGRAM_SCRIPT_ORIGIN = 'https://telegram.org';

/** 128 random bits, base64: a fresh one for every page request. */
export function createNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes));
}

/**
 * The origin of the live / terminal WebSocket (`NEXT_PUBLIC_LIVE_URL`). In
 * development it is the API's own port, another origin than the page.
 */
function liveOrigin(liveUrl: string): string | null {
  try {
    return new URL(liveUrl).origin;
  } catch {
    return null;
  }
}

/**
 * The page policy (F-27). Scripts run only from this origin or with the
 * request's nonce; nothing frames the app (clickjacking on approve / merge),
 * and the app frames only itself — the design viewer's sandboxed mockups come
 * from `/api` (F-28). Styles stay `'unsafe-inline'`: React renders `style`
 * attributes and the UI kit sets them at runtime; a style cannot run code.
 * `telegram`: the Mini App's entry (#580) also runs Telegram's script.
 */
export function contentSecurityPolicy({
  nonce,
  liveUrl = process.env.NEXT_PUBLIC_LIVE_URL ?? DEFAULT_LIVE_URL,
  dev = process.env.NODE_ENV === 'development',
  telegram = false,
}: {
  nonce: string;
  liveUrl?: string;
  dev?: boolean;
  telegram?: boolean;
}): string {
  const live = liveOrigin(liveUrl);
  const directives = [
    "default-src 'self'",
    // React's development build reconstructs call stacks with `eval`.
    `script-src 'self' 'nonce-${nonce}'${telegram ? ` ${TELEGRAM_SCRIPT_ORIGIN}` : ''}${dev ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self'${live ? ` ${live}` : ''}`,
    "frame-src 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ];
  return directives.join('; ');
}

/** True when the browser reached us over TLS, directly or through a proxy. */
function servedOverTls(protocol: string, forwardedProto: string | null) {
  const forwarded = forwardedProto?.split(',')[0]?.trim().toLowerCase();
  return forwarded ? forwarded === 'https' : protocol === 'https:';
}

/**
 * Every security header a page response carries. HSTS only over TLS: on
 * plain HTTP the browser ignores it, and a local `http://` setup must keep
 * working.
 */
export function securityHeaders({
  csp,
  protocol,
  forwardedProto,
}: {
  csp: string;
  protocol: string;
  forwardedProto: string | null;
}): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Security-Policy': csp,
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'X-Content-Type-Options': 'nosniff',
  };
  if (servedOverTls(protocol, forwardedProto)) {
    headers['Strict-Transport-Security'] = 'max-age=31536000';
  }
  return headers;
}

/**
 * WI-74: the shared redactor for text a runner or a CLI wrote — an error a
 * failed `git` or `gh` command echoed — before the API stores it or shows it
 * to anyone, viewers included (D-03 keeps the text, only its secrets go).
 *
 * Redacted:
 * - URL userinfo: `https://user:tok@github.com/o/r` becomes
 *   `https://github.com/o/r [redacted]` — the URL still reads as itself and
 *   the marker says something was cut;
 * - a secret in a query parameter (`?access_token=…`, `password=…`);
 * - token shapes: GitHub (`ghp_…`, `github_pat_…`), GitLab (`glpat-…`),
 *   Slack (`xox?-…`), AWS access key ids, provider keys (`sk-…`, `xai-…`),
 *   and the value of a `Bearer` / `Basic` / `x-api-key` header.
 *
 * Local paths are left alone (D-03 accepts them). Redacting twice changes
 * nothing.
 */

/** What a redacted secret is replaced with, or marked by. */
export const REDACTION_MARKER = '[redacted]';

/**
 * `scheme://userinfo@rest`: userinfo is anything up to the first `@` before a
 * path, space or quote; the rest of the URL runs to a space or quote, without
 * trailing sentence punctuation. A scheme starts only where a scheme character
 * does not precede it, so a long run of letters is scanned once (C-128).
 */
const URL_USERINFO =
  /(?<![a-z0-9+.-])([a-z][a-z0-9+.-]*:\/\/)[^\s/@'"<>]+@((?:[^\s'"<>]*[^\s'"<>.,;:!?)\]])?)/gi;

/** `name=value` where the name says the value is a secret. */
const SECRET_PARAM =
  /(?<![A-Za-z0-9_])((?:access_|auth_|api_|private_|refresh_)?(?:token|key|password|passwd|secret)=)[^\s&'"<>#]+/gi;

const TOKEN_SHAPES = [
  /(?<![A-Za-z0-9_])(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g,
  /(?<![A-Za-z0-9_])glpat-[A-Za-z0-9_-]{20,}/g,
  /(?<![A-Za-z0-9_])xox[abprs]-[A-Za-z0-9-]{10,}/g,
  /(?<![A-Za-z0-9_])(?:AKIA|ASIA)[0-9A-Z]{16}(?![A-Za-z0-9])/g,
  /(?<![A-Za-z0-9_])(?:sk|xai)-[A-Za-z0-9_-]{16,}/g,
];

/** A header whose value is the secret: the name is kept, the value goes. */
const HEADER_VALUES = [
  /\b((?:Bearer|Basic)\s+)[A-Za-z0-9._~+/-]{8,}=*/gi,
  /\b(x-api-key["']?\s*[:=]\s*["']?)[^\s"',}]+/gi,
];

/** `text` with URL userinfo, secret parameters and token shapes redacted. */
export const redactSecrets = (text: string): string => {
  let out = text.replace(
    URL_USERINFO,
    (_match, scheme: string, rest: string) =>
      `${scheme}${rest} ${REDACTION_MARKER}`,
  );
  out = out.replace(SECRET_PARAM, `$1${REDACTION_MARKER}`);
  for (const shape of TOKEN_SHAPES) out = out.replace(shape, REDACTION_MARKER);
  for (const header of HEADER_VALUES) {
    out = out.replace(header, `$1${REDACTION_MARKER}`);
  }
  return out;
};

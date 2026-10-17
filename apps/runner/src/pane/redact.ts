import { redactUrlUserinfo } from '../redact-url';

/** What replaces a masked secret (spec 18 D5). */
export const MASK = '•••';

/**
 * The runner's one redactor (C-128): every text the runner sends the server
 * — pane frames, run logs, reports, checkpoints, messages, PR bodies,
 * skill-run patches, hook content — goes through `redact` / `redactText`.
 * Pattern-based and best-effort: an ANSI code inside a token defeats a match.
 *
 * Tool input arrives as JSON, so a multi-line file is one line with `\n`
 * escapes: every line rule below also matches inside such a line.
 */

/** Single-line token shapes. */
const TOKENS: readonly RegExp[] = [
  /gh[pousr]_[A-Za-z0-9]{36,}/g,
  /github_pat_[A-Za-z0-9_]{22,}/g,
  /glpat-[A-Za-z0-9_-]{20,}/g,
  /\b[rs]k_(?:live|test)_[A-Za-z0-9]{10,}/g,
  /sk-[A-Za-z0-9_-]{20,}/g,
  /xox(?:e\.xox[bp]|[abposre])-[A-Za-z0-9-]{10,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /AIza[0-9A-Za-z_-]{35}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
];

const KEY_BEGIN = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const KEY_END = /-----END [A-Z ]*PRIVATE KEY-----/;

/**
 * A secret-sounding name assigned anywhere: `API_KEY=…`, `"DB_PASSWORD": "…"`
 * is left to the JSON rule. Name parts are bounded: an unbounded one makes a
 * long upper-case run quadratic, and this rule runs over whole patches.
 */
const SECRET_ASSIGNMENT =
  /\b([A-Z0-9_]{0,64}(?:SECRET|TOKEN|KEY|PASSWORD|PASSWD|PWD|PASS|AUTH|CREDENTIALS?|DSN|PRIVATE|DATABASE_URL|CONNECTION_STRING)[A-Z0-9_]{0,64})(\s*=\s*)("[^"\n]*"|'[^'\n]*'|[^\s"'\\]+)/g;

/**
 * A `.env` line: `[export ]NAME=value` at the start of a real line, or of an
 * added or removed line of a diff. Spaces around `=` only with an upper-case
 * name, so code such as `  x = 5` in a pane or a patch stays readable.
 */
const ENV_LINE =
  /^([+-]?\s*(?:export\s+)?(?:[A-Za-z_][A-Za-z0-9_]*=|[A-Z_][A-Z0-9_]*\s+=\s*))(\S.*)$/;

/** The same inside escaped text: `\nNAME=value` up to the next escape or quote. */
const ESCAPED_ENV_LINE =
  /(\\n\s*(?:export\s+)?[A-Z_][A-Z0-9_]*\s*=\s*)([^\s"\\]+)/g;

/** `Authorization: Bearer …`, header or JSON. */
const AUTHORIZATION =
  /(authorization["']?\s*[:=]\s*["']?(?:bearer\s+|basic\s+|token\s+)?)[^\s"'\\,}]+/gi;

/** A JSON member whose key sounds secret: `"api_key": "…"`. */
const SECRET_MEMBER =
  /("[A-Za-z0-9_-]{0,64}(?:secret|token|password|passwd|api[_-]?key|private[_-]?key|credentials?)[A-Za-z0-9_-]{0,64}"\s*:\s*)"(?:[^"\\]|\\.)*"/gi;

/** Every single-line rule, on a part of a line outside a private-key block. */
const redactPart = (text: string): string => {
  const tokens = redactUrlUserinfo(
    TOKENS.reduce((acc, pattern) => acc.replace(pattern, MASK), text),
  );
  const env = ENV_LINE.exec(tokens);
  const base = env ? `${env[1]}${MASK}` : tokens;
  return base
    .replace(
      SECRET_ASSIGNMENT,
      (_m, name: string, eq: string) => `${name}${eq}${MASK}`,
    )
    .replace(ESCAPED_ENV_LINE, (_m, head: string) => `${head}${MASK}`)
    .replace(AUTHORIZATION, (_m, head: string) => `${head}${MASK}`)
    .replace(SECRET_MEMBER, (_m, head: string) => `${head}"${MASK}"`);
};

/**
 * Masks secret-looking strings in a capture (spec 18 D5). A private-key block
 * is masked from its `BEGIN` marker through its `END` marker, however many
 * lines it spans; one that is cut off by the top of the capture has no marker
 * to start from and is left alone.
 */
export const redact = (lines: readonly string[]): string[] => {
  let inKey = false;
  return lines.map((line) => {
    if (inKey) {
      const end = KEY_END.exec(line);
      if (!end) return MASK;
      inKey = false;
      return MASK + redactPart(line.slice(end.index + end[0].length));
    }
    const begin = KEY_BEGIN.exec(line);
    if (begin) {
      const rest = line.slice(begin.index);
      const end = KEY_END.exec(rest);
      if (end) {
        return (
          redactPart(line.slice(0, begin.index)) +
          MASK +
          redactPart(rest.slice(end.index + end[0].length))
        );
      }
      inKey = true;
      return redactPart(line.slice(0, begin.index)) + MASK;
    }
    return redactPart(line);
  });
};

/** Redacts a whole text, line by line, private-key blocks across lines. */
export const redactText = (text: string): string =>
  redact(text.split('\n')).join('\n');

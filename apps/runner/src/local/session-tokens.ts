import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { z } from 'zod';

/**
 * #113: the env var that carries a session's capability token to its hook
 * and MCP processes — set by the runner on the sessions it launches.
 */
export const SESSION_TOKEN_ENV = 'NAUTELLE_SESSION_TOKEN';

/** A token on a socket line is never longer than this. */
export const SESSION_TOKEN_MAX = 1024;

const PREFIX = 'adst1';

/** What a session token stands for: the session and the cwd it started in. */
export interface SessionBinding {
  sessionId: string;
  cwd: string;
}

const bindingSchema = z.object({
  s: z.string().min(1).max(200),
  c: z.string().min(1).max(4096),
});

/**
 * #113: per-session capability tokens for the local socket. A token is
 * `adst1.<binding>.<hmac>`: the binding (session id, cwd) signed with the
 * daemon's secret, so it is checked without state and survives a daemon
 * restart as long as the secret file does — a card round outlives the
 * daemon (#482). The project is the binding cwd's correlation, never a
 * caller's claim.
 */
export class SessionTokens {
  constructor(private readonly secret: Buffer) {}

  mint(binding: SessionBinding): string {
    const body = Buffer.from(
      JSON.stringify({ s: binding.sessionId, c: binding.cwd }),
    ).toString('base64url');
    return `${PREFIX}.${body}.${this.sign(body)}`;
  }

  /** The binding of a token this daemon's secret signed; null for any other. */
  verify(token: string): SessionBinding | null {
    const [prefix, body, mac, ...rest] = token.split('.');
    if (prefix !== PREFIX || !body || !mac || rest.length > 0) return null;
    const expected = Buffer.from(this.sign(body));
    const given = Buffer.from(mac);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      return null;
    }
    try {
      const parsed = bindingSchema.safeParse(
        JSON.parse(Buffer.from(body, 'base64url').toString('utf8')),
      );
      return parsed.success
        ? { sessionId: parsed.data.s, cwd: parsed.data.c }
        : null;
    } catch {
      return null;
    }
  }

  private sign(body: string): string {
    return createHmac('sha256', this.secret)
      .update(`${PREFIX}.${body}`)
      .digest('base64url');
  }
}

/**
 * The daemon's signing secret, created 0600 on first use. Every token minted
 * before the file is replaced stops verifying with it.
 */
export const loadSessionTokenSecret = (path: string): Buffer => {
  try {
    const existing = readFileSync(path);
    if (existing.length >= 32) return existing;
  } catch {
    // Created below.
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const secret = randomBytes(32);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, secret, { mode: 0o600 });
  renameSync(tmp, path);
  return secret;
};

/** `cwd` is `root` or below it: a session may `cd` inside its own tree. */
export const cwdWithin = (cwd: string, root: string): boolean => {
  const rel = relative(root, cwd);
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith('/'));
};

// The client side: where a session the runner did not launch keeps the
// token its `SessionStart` was given, for its later hooks and its MCP server.

/** Beside the socket, in its 0700 directory. */
export const sessionTokenDir = (socketPath: string): string =>
  join(dirname(socketPath), 'session-tokens');

const SAFE_NAME = /^[A-Za-z0-9_-]{1,200}$/;

const storedSchema = z.object({
  token: z.string().min(1).max(SESSION_TOKEN_MAX),
  pid: z.number().int().positive().optional(),
});

const sessionFile = (dir: string, sessionId: string): string | null =>
  SAFE_NAME.test(sessionId) ? join(dir, `s-${sessionId}.json`) : null;

const pidFile = (dir: string, pid: number): string =>
  join(dir, `p-${pid}.json`);

const writePrivate = (path: string, value: unknown): void => {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  renameSync(tmp, path);
};

const readStored = (path: string): z.infer<typeof storedSchema> | null => {
  try {
    const parsed = storedSchema.safeParse(
      JSON.parse(readFileSync(path, 'utf8')),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

/**
 * Keeps a session's token by its id (for its hooks) and by its `claude`
 * pid (for its MCP server, which knows only its parent). Best-effort.
 */
export const saveSessionToken = (
  dir: string,
  session: { sessionId: string; claudePid?: number },
  token: string,
): void => {
  const file = sessionFile(dir, session.sessionId);
  if (!file) return;
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    writePrivate(file, {
      token,
      ...(session.claudePid ? { pid: session.claudePid } : {}),
    });
    if (session.claudePid) {
      writePrivate(pidFile(dir, session.claudePid), { token });
    }
  } catch {
    // The session's later calls are refused; it never breaks the session.
  }
};

/** The token a hook of `sessionId` keeps, or the one of the `claude` at `pid`. */
export const readSessionToken = (
  dir: string,
  key: { sessionId: string } | { pid: number },
): string | null => {
  const file =
    'sessionId' in key
      ? sessionFile(dir, key.sessionId)
      : pidFile(dir, key.pid);
  return file ? (readStored(file)?.token ?? null) : null;
};

/** `SessionEnd`: the session's files go. */
export const forgetSessionToken = (dir: string, sessionId: string): void => {
  const file = sessionFile(dir, sessionId);
  if (!file) return;
  const pid = readStored(file)?.pid;
  rmSync(file, { force: true });
  if (pid) rmSync(pidFile(dir, pid), { force: true });
};

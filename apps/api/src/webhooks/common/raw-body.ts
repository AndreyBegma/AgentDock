import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  INBOUND_BODY_MAX_BYTES,
  INBOUND_HOOK_PATH_PREFIX,
} from '@agentdock/shared';

/**
 * Raw request body capture for signed webhooks (docs/specs/26-webhooks.md D8).
 *
 * On the routes listed in `RAW_BODY_ROUTES` the body is read as bytes into
 * `req.rawBody` and **not** parsed: a handler verifies the signature over the
 * exact bytes first, then parses with `parseRawJson`. The stream is consumed
 * here, so Nest's own JSON and form parsers skip these requests; every other
 * route is untouched. Registered by `configureApp`, so `main.ts` and the e2e
 * app behave the same.
 */

/** Path prefixes whose bodies are captured raw. #27 appends its own route. */
export const RAW_BODY_ROUTES: readonly string[] = [INBOUND_HOOK_PATH_PREFIX];

/** A request that went through `rawBodyMiddleware`. */
export interface RawBodyRequest extends IncomingMessage {
  rawBody?: Buffer;
}

const sendError = (
  res: ServerResponse,
  statusCode: number,
  error: string,
  message: string,
) => {
  if (res.headersSent) return;
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Connection', 'close');
  res.end(JSON.stringify({ statusCode, error, message }));
};

const pathOf = (req: IncomingMessage): string => {
  const url = req.url ?? '';
  const query = url.indexOf('?');
  return query >= 0 ? url.slice(0, query) : url;
};

const matches = (path: string, routes: readonly string[]): boolean =>
  routes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));

const isJson = (req: IncomingMessage): boolean => {
  const type = req.headers['content-type'];
  if (!type) return false;
  return type.split(';')[0].trim().toLowerCase() === 'application/json';
};

/**
 * Connect-style middleware. Only `POST` with `Content-Type: application/json`
 * is read; anything else passes through unread and is refused downstream
 * (the CSRF guard answers 415 to a non-JSON public request). Over
 * `maxBytes` → 413; a compressed body → 415, since the signature covers the
 * bytes as sent.
 */
export const rawBodyMiddleware =
  (
    routes: readonly string[] = RAW_BODY_ROUTES,
    maxBytes: number = INBOUND_BODY_MAX_BYTES,
  ) =>
  (
    req: RawBodyRequest,
    res: ServerResponse,
    next: (error?: unknown) => void,
  ) => {
    if (
      req.method !== 'POST' ||
      !matches(pathOf(req), routes) ||
      !isJson(req)
    ) {
      next();
      return;
    }
    const tooLarge = () => {
      const message = `Body exceeds ${maxBytes} bytes`;
      sendError(res, 413, 'payload_too_large', message);
      req.resume();
    };
    const encoding = req.headers['content-encoding'];
    if (encoding && encoding.toLowerCase() !== 'identity') {
      const message = 'Compressed bodies are not accepted';
      sendError(res, 415, 'unsupported_media_type', message);
      return;
    }
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBytes) {
      tooLarge();
      return;
    }

    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    req.on('data', (chunk: Buffer) => {
      if (done) return;
      size += chunk.length;
      if (size > maxBytes) {
        done = true;
        tooLarge();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      req.rawBody = Buffer.concat(chunks);
      next();
    });
    req.on('error', (error) => {
      if (done) return;
      done = true;
      next(error);
    });
  };

export type RawJson = { ok: true; value: unknown } | { ok: false };

/** D8: the captured body as JSON — called only after the signature verified. */
export const parseRawJson = (rawBody: Buffer | undefined): RawJson => {
  if (!rawBody || rawBody.length === 0) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(rawBody.toString('utf8')) as unknown };
  } catch {
    return { ok: false };
  }
};

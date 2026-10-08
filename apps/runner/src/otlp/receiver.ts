import { gunzipSync } from 'node:zlib';
import type { UnsequencedEvent } from '@agentdock/shared/protocol';
import type { Server } from 'bun';
import { errorMessage, type Logger } from '../log';
import {
  decodeJson,
  decodeProtobuf,
  EMPTY_RESPONSE_JSON,
  EMPTY_RESPONSE_PROTOBUF,
  OtlpDecodeError,
  type OtlpLogRecord,
} from './decode';
import { type EnvelopeProject, mapLogRecords } from './map';

/** D16: a request body larger than this is refused, compressed or inflated. */
export const MAX_BODY_BYTES = 4 * 1024 * 1024;
/** D11: loopback only, always. The port is the only thing configuration picks. */
export const OTLP_HOST = '127.0.0.1';
export const DEFAULT_OTLP_HTTP_PORT = 4318;

const PROTOBUF = 'application/x-protobuf';
const JSON_TYPE = 'application/json';

export interface ReceiverDeps {
  emit: (event: UnsequencedEvent) => void;
  /** Envelope projects for the `agentdock.project` ids of one request (D14). */
  projects: (ids: Iterable<string>) => Promise<Map<string, EnvelopeProject>>;
  codexExperimental: boolean;
  now: () => string;
  log: Logger;
}

/** 127.0.0.0/8 and ::1, plain or IPv4-mapped. */
export const isLoopback = (address: string | null | undefined): boolean => {
  if (!address) return false;
  const v4 = address.startsWith('::ffff:') ? address.slice(7) : address;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4)) return true;
  return address === '::1' || address === '0:0:0:0:0:0:0:1';
};

type Encoding = 'protobuf' | 'json';

const encodingOf = (request: Request): Encoding | null => {
  const type = (request.headers.get('content-type') ?? '')
    .split(';')[0]
    ?.trim()
    .toLowerCase();
  if (type === PROTOBUF) return 'protobuf';
  if (type === JSON_TYPE) return 'json';
  return null;
};

const success = (encoding: Encoding | null): Response =>
  encoding === 'json'
    ? new Response(EMPTY_RESPONSE_JSON, {
        headers: { 'content-type': JSON_TYPE },
      })
    : new Response(EMPTY_RESPONSE_PROTOBUF, {
        headers: { 'content-type': PROTOBUF },
      });

const failure = (status: number, message: string): Response =>
  new Response(JSON.stringify({ message }), {
    status,
    headers: { 'content-type': JSON_TYPE },
  });

class TooLarge extends Error {}

/** Reads the body, refusing it as soon as it crosses the cap. */
const readCapped = async (request: Request): Promise<Uint8Array> => {
  const declared = Number(request.headers.get('content-length') ?? Number.NaN);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new TooLarge();
  }
  if (!request.body) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = request.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      throw new TooLarge();
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
};

class UnsupportedEncoding extends Error {}

/** `gzip` inflated under the same cap; no other encoding is accepted. */
const inflate = (body: Uint8Array, encoding: string | null): Uint8Array => {
  const value = encoding?.trim().toLowerCase();
  if (!value || value === 'identity') return body;
  if (value !== 'gzip') throw new UnsupportedEncoding(value);
  try {
    return new Uint8Array(
      gunzipSync(body, { maxOutputLength: MAX_BODY_BYTES }),
    );
  } catch (error) {
    if (error instanceof RangeError) throw new TooLarge();
    throw new OtlpDecodeError(`bad gzip: ${errorMessage(error)}`);
  }
};

const projectIds = (records: readonly OtlpLogRecord[]): Set<string> => {
  const ids = new Set<string>();
  for (const record of records) {
    const id =
      record.attributes['agentdock.project'] ??
      record.resource['agentdock.project'];
    if (typeof id === 'string' && id.length > 0) ids.add(id);
  }
  return ids;
};

/**
 * One OTLP/HTTP request (D11, D16). `peer` is the remote address; anything
 * but loopback is refused before the body is read.
 */
export const handleOtlpRequest = async (
  request: Request,
  peer: string | null,
  deps: ReceiverDeps,
): Promise<Response> => {
  if (!isLoopback(peer)) return failure(403, 'loopback only');
  const { pathname } = new URL(request.url);
  const known =
    pathname === '/v1/logs' ||
    pathname === '/v1/metrics' ||
    pathname === '/v1/traces';
  if (!known) return failure(404, 'not found');
  if (request.method !== 'POST') return failure(405, 'POST only');
  const encoding = encodingOf(request);
  if (!encoding) return failure(415, `expected ${PROTOBUF} or ${JSON_TYPE}`);

  let body: Uint8Array;
  try {
    body = inflate(
      await readCapped(request),
      request.headers.get('content-encoding'),
    );
  } catch (error) {
    if (error instanceof TooLarge) return failure(413, 'body over 4 MiB');
    if (error instanceof UnsupportedEncoding) {
      return failure(415, `content-encoding ${error.message}`);
    }
    if (error instanceof OtlpDecodeError) return failure(400, error.message);
    throw error;
  }

  // Metrics and traces are accepted so exporters stay quiet, and discarded.
  if (pathname !== '/v1/logs') return success(encoding);

  let records: OtlpLogRecord[];
  try {
    records =
      encoding === 'protobuf'
        ? decodeProtobuf(body)
        : decodeJson(new TextDecoder().decode(body));
  } catch (error) {
    if (error instanceof OtlpDecodeError) return failure(400, error.message);
    throw error;
  }

  const projects = await deps.projects(projectIds(records));
  const { events, dropped } = mapLogRecords(records, {
    project: (id) => projects.get(id),
    codexExperimental: deps.codexExperimental,
    now: deps.now,
  });
  if (dropped > 0) {
    deps.log.warn('otlp: dropped request records without id or model', {
      dropped,
    });
  }
  try {
    for (const event of events) deps.emit(event);
  } catch (error) {
    // The spool could not take them: 503 is retryable, so the exporter resends.
    deps.log.error('otlp: cannot spool events', { error: errorMessage(error) });
    return failure(503, 'cannot store events');
  }
  return success(encoding);
};

export interface OtlpReceiverOptions extends ReceiverDeps {
  /** 0 picks a free port (tests). */
  port: number;
}

/** The OTLP/HTTP receiver (spec 13 D11–D16), bound to 127.0.0.1 only. */
export class OtlpReceiver {
  private server: Server<undefined> | null = null;

  constructor(private readonly options: OtlpReceiverOptions) {}

  /** The port it listens on, once started. */
  get port(): number | null {
    return this.server?.port ?? null;
  }

  /** Binds the port. Throws when it cannot — the caller decides what then. */
  start(): number {
    const options = this.options;
    const server = Bun.serve({
      hostname: OTLP_HOST,
      port: options.port,
      // Bun's own guard; the handler enforces the cap on streamed bodies too.
      maxRequestBodySize: MAX_BODY_BYTES,
      fetch: (request, srv) =>
        handleOtlpRequest(
          request,
          srv.requestIP(request)?.address ?? null,
          options,
        ).catch((error: unknown) => {
          options.log.error('otlp: request failed', {
            error: errorMessage(error),
          });
          return failure(500, 'internal error');
        }),
    });
    this.server = server;
    return server.port ?? options.port;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    await server?.stop(true);
  }
}

import protobuf from 'protobufjs/light';
import descriptor from './proto/logs.json';

/**
 * OTLP logs (spec 13 D11, D12), decoded into the few things the mapping reads.
 * Only scalar attribute values are kept; arrays, maps and bytes are dropped
 * here, so nothing nested ever reaches the mapping.
 */
export type AttributeValue = string | number | boolean;
export type Attributes = Readonly<Record<string, AttributeValue>>;

export interface OtlpLogRecord {
  /** Nanoseconds since the epoch, as a decimal string; null when unset. */
  timeUnixNano: string | null;
  /** The body when it is a string — Claude Code puts the event name there. */
  body: string | null;
  /** `LogRecord.event_name`, when the exporter sets it. */
  eventName: string | null;
  attributes: Attributes;
  /** The attributes of the resource the record was exported under. */
  resource: Attributes;
}

export class OtlpDecodeError extends Error {}

const root = protobuf.Root.fromJSON(descriptor);
const ExportLogsServiceRequest = root.lookupType(
  'opentelemetry.proto.collector.logs.v1.ExportLogsServiceRequest',
);
const ExportLogsServiceResponse = root.lookupType(
  'opentelemetry.proto.collector.logs.v1.ExportLogsServiceResponse',
);

/** An empty `ExportLogsServiceResponse`: full success. */
export const EMPTY_RESPONSE_PROTOBUF: Uint8Array =
  ExportLogsServiceResponse.encode(
    ExportLogsServiceResponse.create({}),
  ).finish();
export const EMPTY_RESPONSE_JSON = '{}';

/** Plain-object conversion: 64-bit integers as decimal strings, enums as numbers. */
const TO_OBJECT: protobuf.IConversionOptions = {
  longs: String,
  enums: Number,
  bytes: String,
  defaults: false,
  arrays: true,
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const list = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.filter(isRecord) : [];

/** `intValue` arrives as a decimal string; a value past 2^53 stays a string. */
const scalar = (value: unknown): AttributeValue | undefined => {
  if (!isRecord(value)) return undefined;
  if (typeof value.stringValue === 'string') return value.stringValue;
  if (typeof value.boolValue === 'boolean') return value.boolValue;
  if (typeof value.doubleValue === 'number') return value.doubleValue;
  const int = value.intValue;
  if (typeof int === 'number') return int;
  if (typeof int === 'string' && /^-?\d+$/.test(int)) {
    const n = Number(int);
    return Number.isSafeInteger(n) ? n : int;
  }
  return undefined;
};

const attributesOf = (value: unknown): Attributes => {
  const out: Record<string, AttributeValue> = {};
  for (const kv of list(value)) {
    if (typeof kv.key !== 'string' || kv.key.length === 0) continue;
    const v = scalar(kv.value);
    if (v !== undefined) out[kv.key] = v;
  }
  return out;
};

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;

/** Flattens a request already in protobufjs plain-object form. */
const flatten = (request: Record<string, unknown>): OtlpLogRecord[] => {
  const records: OtlpLogRecord[] = [];
  for (const resourceLogs of list(request.resourceLogs)) {
    const resource = isRecord(resourceLogs.resource)
      ? attributesOf(resourceLogs.resource.attributes)
      : {};
    for (const scopeLogs of list(resourceLogs.scopeLogs)) {
      for (const record of list(scopeLogs.logRecords)) {
        const body = scalar(record.body);
        records.push({
          timeUnixNano: text(record.timeUnixNano),
          body: typeof body === 'string' ? body : null,
          eventName: text(record.eventName),
          attributes: attributesOf(record.attributes),
          resource,
        });
      }
    }
  }
  return records;
};

/** `application/x-protobuf`: an `ExportLogsServiceRequest`. */
export const decodeProtobuf = (body: Uint8Array): OtlpLogRecord[] => {
  let message: protobuf.Message;
  try {
    message = ExportLogsServiceRequest.decode(body);
  } catch (error) {
    throw new OtlpDecodeError(
      `not an ExportLogsServiceRequest: ${(error as Error).message}`,
    );
  }
  return flatten(ExportLogsServiceRequest.toObject(message, TO_OBJECT));
};

/**
 * `application/json`: the OTLP/JSON encoding — lowerCamelCase fields, 64-bit
 * integers as strings or numbers. Read directly rather than through
 * `fromObject`, which expects base64 where OTLP/JSON sends hex trace ids.
 */
export const decodeJson = (body: string): OtlpLogRecord[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new OtlpDecodeError('not valid JSON');
  }
  if (!isRecord(parsed)) {
    throw new OtlpDecodeError('not an ExportLogsServiceRequest object');
  }
  return flatten(parsed);
};

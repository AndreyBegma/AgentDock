import { describe, expect, it } from 'bun:test';
import { decodeJson, decodeProtobuf, OtlpDecodeError } from './decode';
import {
  fixtureJson,
  fixtureProtobuf,
  JSON_SESSION,
  PROTOBUF_SESSION,
} from './testing';

const names = (records: { body: string | null }[]) =>
  records.map((r) => r.body);

const CAPTURED = [
  'claude_code.user_prompt',
  'claude_code.api_request',
  'claude_code.tool_decision',
  'claude_code.tool_result',
  'claude_code.api_request',
  'claude_code.assistant_response',
];

describe('otlp decode', () => {
  it('decodes the captured protobuf export', () => {
    const records = decodeProtobuf(fixtureProtobuf());
    expect(names(records)).toEqual(CAPTURED);
    const request = records[1];
    expect(request?.attributes['session.id']).toBe(PROTOBUF_SESSION);
    expect(request?.attributes.input_tokens).toBe(2);
    expect(request?.attributes.cost_usd).toBe(0.00384153);
    expect(request?.timeUnixNano).toBe('1791447578542000000');
    expect(request?.resource['service.name']).toBe('claude-code');
    expect(request?.resource['agentdock.project']).toBe('prj_fixture');
  });

  it('decodes the captured JSON export to the same shape', () => {
    const json = decodeJson(fixtureJson());
    const pb = decodeProtobuf(fixtureProtobuf());
    expect(names(json)).toEqual(CAPTURED);
    expect(json[1]?.attributes['session.id']).toBe(JSON_SESSION);
    // Same attribute names and value types record by record.
    json.forEach((record, i) => {
      const other = pb[i];
      expect(Object.keys(record.attributes).sort()).toEqual(
        Object.keys(other?.attributes ?? {}).sort(),
      );
      for (const [key, value] of Object.entries(record.attributes)) {
        expect(typeof value).toBe(typeof other?.attributes[key]);
      }
    });
  });

  it('reads int64 as string or number, and drops non-scalar values', () => {
    const [record] = decodeJson(
      JSON.stringify({
        resourceLogs: [
          {
            scopeLogs: [
              {
                logRecords: [
                  {
                    eventName: 'x',
                    attributes: [
                      { key: 'a', value: { intValue: '42' } },
                      { key: 'b', value: { intValue: 7 } },
                      { key: 'big', value: { intValue: '9007199254740993' } },
                      { key: 'arr', value: { arrayValue: { values: [] } } },
                      { key: 'kv', value: { kvlistValue: { values: [] } } },
                      { key: 'bytes', value: { bytesValue: 'AAE=' } },
                      { key: 'ok', value: { boolValue: true } },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      }),
    );
    expect(record?.eventName).toBe('x');
    expect(record?.attributes).toEqual({
      a: 42,
      b: 7,
      big: '9007199254740993',
      ok: true,
    });
  });

  it('refuses a body that is not an export request', () => {
    expect(() => decodeProtobuf(new Uint8Array([0x0a, 0xff, 0xff]))).toThrow(
      OtlpDecodeError,
    );
    expect(() => decodeJson('{not json')).toThrow(OtlpDecodeError);
    expect(() => decodeJson('[1,2]')).toThrow(OtlpDecodeError);
  });

  it('is empty for an empty request', () => {
    expect(decodeProtobuf(new Uint8Array())).toEqual([]);
    expect(decodeJson('{}')).toEqual([]);
  });
});

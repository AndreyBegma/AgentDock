import { describe, expect, it } from 'bun:test';
import { statSync } from 'node:fs';
import {
  type LlmRequestData,
  parseSessionEvent,
} from '@agentdock/shared/protocol';
import { claudeAdapter } from '../adapters/claude/adapter';
import { freshState } from '../adapters/types';
import { decodeJson, decodeProtobuf, type OtlpLogRecord } from './decode';
import {
  claudeQuerySource,
  type EnvelopeProject,
  type MapContext,
  mapLogRecords,
} from './map';
import {
  FIXTURE_TRANSCRIPT,
  FORBIDDEN,
  fixtureJson,
  fixtureProtobuf,
  JSON_SESSION,
  PROTOBUF_SESSION,
} from './testing';

const PROJECT: EnvelopeProject = {
  repo: 'AndreyBegma/fixture',
  root: '/home/person/dev/fixture',
};

const context = (overrides: Partial<MapContext> = {}): MapContext => ({
  project: (id) => (id === 'prj_fixture' ? PROJECT : undefined),
  codexExperimental: false,
  now: () => '2026-10-08T00:00:00.000Z',
  ...overrides,
});

const record = (
  attributes: Record<string, string | number | boolean>,
  body = 'claude_code.api_request',
): OtlpLogRecord => ({
  timeUnixNano: '1791447584500000000',
  body,
  eventName: null,
  attributes,
  resource: { 'service.name': 'claude-code' },
});

const REQUEST = {
  'session.id': 's-1',
  request_id: 'req_1',
  model: 'claude-sonnet-4-5-20250929',
  input_tokens: 10,
  output_tokens: 20,
};

/** Keys `llm.request` data may carry from OTel: D13 plus the D14 `run`. */
const ALLOWED_DATA_KEYS = new Set([
  'requestId',
  'promptId',
  'model',
  'tokens',
  'durationMs',
  'ttftMs',
  'querySource',
  'agentName',
  'reportedCostUsd',
  'cacheWriteTtlUnknown',
  'source',
  'run',
]);

describe('otlp map — Claude Code (D13, D14)', () => {
  it('maps each api_request of the JSON capture to one llm.request', () => {
    const { events, dropped } = mapLogRecords(
      decodeJson(fixtureJson()),
      context(),
    );
    expect(dropped).toBe(0);
    expect(events).toEqual([
      {
        v: 1,
        ts: '2026-10-08T08:19:44.500Z',
        type: 'llm.request',
        source: 'otel',
        project: PROJECT,
        slot: 'i42-api',
        issue: 42,
        session: { runtime: 'claude', id: JSON_SESSION },
        data: {
          requestId: 'req_011CfpSejQAmqSghrb3aA23n',
          promptId: '9bf4356e-17e6-4ebe-a03e-ea698cc47bed',
          model: 'claude-haiku-5-5',
          tokens: {
            input: 2,
            output: 101,
            cacheRead: 29281,
            cacheWrite5m: 0,
            cacheWrite1h: 0,
            reasoning: 0,
          },
          durationMs: 1330,
          ttftMs: 987,
          querySource: 'main',
          reportedCostUsd: 0.00034351,
          source: 'otel',
          run: 'run_fixture',
        },
      },
      {
        v: 1,
        ts: '2026-10-08T08:19:45.985Z',
        type: 'llm.request',
        source: 'otel',
        project: PROJECT,
        slot: 'i42-api',
        issue: 42,
        session: { runtime: 'claude', id: JSON_SESSION },
        data: {
          requestId: 'req_011CfpSesVaEqnspJvvovFo5',
          promptId: '9bf4356e-17e6-4ebe-a03e-ea698cc47bed',
          model: 'claude-haiku-5-5',
          tokens: {
            input: 2,
            output: 3,
            cacheRead: 29281,
            cacheWrite5m: 155,
            cacheWrite1h: 0,
            reasoning: 0,
          },
          durationMs: 901,
          ttftMs: 884,
          querySource: 'main',
          reportedCostUsd: 0.00032551,
          cacheWriteTtlUnknown: true,
          source: 'otel',
          run: 'run_fixture',
        },
      },
    ]);
  });

  it('maps the protobuf capture the same way', () => {
    const { events } = mapLogRecords(
      decodeProtobuf(fixtureProtobuf()),
      context(),
    );
    expect(events).toHaveLength(2);
    expect(events[0]?.session).toEqual({
      runtime: 'claude',
      id: PROTOBUF_SESSION,
    });
    expect(events[0]?.ts).toBe('2026-10-08T08:19:38.542Z');
    expect(events[0]?.data).toEqual({
      requestId: 'req_011CfpSeKjs132HEWnYFmr5V',
      promptId: 'bd670268-9701-4fc7-a1d3-9faa69456300',
      model: 'claude-haiku-5-5',
      tokens: {
        input: 2,
        output: 102,
        cacheRead: 10873,
        cacheWrite5m: 18408,
        cacheWrite1h: 0,
        reasoning: 0,
      },
      durationMs: 910,
      ttftMs: 584,
      querySource: 'main',
      reportedCostUsd: 0.00384153,
      cacheWriteTtlUnknown: true,
      source: 'otel',
      run: 'run_fixture',
    });
    expect(events[1]?.data).toMatchObject({
      requestId: 'req_011CfpSeQninp1snPHJU7AE6',
    });
  });

  it('sends nothing but the D13 fields, even with prompts and tool details on (D16)', () => {
    const records = [
      ...decodeJson(fixtureJson()),
      ...decodeProtobuf(fixtureProtobuf()),
    ];
    // The capture really does carry content: the test would be empty otherwise.
    const input = JSON.stringify(records);
    for (const value of FORBIDDEN.slice(0, 6)) expect(input).toContain(value);

    const { events } = mapLogRecords(records, context());
    expect(events).toHaveLength(4);
    const sent = JSON.stringify(events);
    for (const value of FORBIDDEN) expect(sent).not.toContain(value);
    for (const key of ['prompt', 'tool_input', 'response', 'user.email']) {
      expect(sent).not.toContain(`"${key}"`);
    }
    for (const event of events) {
      for (const key of Object.keys(event.data as object)) {
        expect(ALLOWED_DATA_KEYS.has(key)).toBe(true);
      }
    }
  });

  it('passes the shared session-event parse', () => {
    const { events } = mapLogRecords(decodeJson(fixtureJson()), context());
    for (const [i, event] of events.entries()) {
      const parsed = parseSessionEvent({ ...event, seq: i + 1 });
      expect(parsed?.ok).toBe(true);
      if (!parsed?.ok) continue;
      const data = parsed.event.data as LlmRequestData;
      expect(data.requestId).toBe((event.data as LlmRequestData).requestId);
      expect(data.tokens).toEqual((event.data as LlmRequestData).tokens);
    }
  });

  it('leaves the project off for an id outside the watch list, keeps slot and issue', () => {
    const { events } = mapLogRecords(
      decodeJson(fixtureJson()),
      context({ project: () => undefined }),
    );
    expect(events[0]?.project).toBeUndefined();
    expect(events[0]?.slot).toBe('i42-api');
    expect(events[0]?.issue).toBe(42);
  });

  it('carries no correlation when the session has no agentdock attributes', () => {
    const { events } = mapLogRecords([record(REQUEST)], context());
    expect(events).toHaveLength(1);
    const [event] = events;
    expect(event?.project).toBeUndefined();
    expect(event?.slot).toBeUndefined();
    expect(event?.issue).toBeUndefined();
    expect(event?.data).not.toHaveProperty('run');
    expect(event?.data).not.toHaveProperty('cacheWriteTtlUnknown');
  });

  it('ignores a non-numeric issue', () => {
    const { events } = mapLogRecords(
      [record({ ...REQUEST, 'agentdock.issue': 'abc' })],
      context(),
    );
    expect(events[0]?.issue).toBeUndefined();
  });

  it('drops a request without a session, request id or model, and counts it', () => {
    const { events, dropped } = mapLogRecords(
      [
        record({ ...REQUEST, 'session.id': '' }),
        record({ ...REQUEST, request_id: '' }),
        record({ ...REQUEST, model: '' }),
        record(REQUEST),
      ],
      context(),
    );
    expect(events).toHaveLength(1);
    expect(dropped).toBe(3);
  });

  it('ignores every other event, and Codex while it is experimental', () => {
    const { events, dropped } = mapLogRecords(
      [
        record(REQUEST, 'claude_code.user_prompt'),
        record(REQUEST, 'claude_code.tool_result'),
        record(REQUEST, 'codex.api_request'),
        record(REQUEST, 'codex.sse_event'),
      ],
      context(),
    );
    expect(events).toEqual([]);
    expect(dropped).toBe(0);
  });

  it('reads the record time when event.timestamp is absent', () => {
    const { events } = mapLogRecords([record(REQUEST)], context());
    expect(events[0]?.ts).toBe('2026-10-08T08:19:44.500Z');
    const untimed = { ...record(REQUEST), timeUnixNano: null };
    expect(mapLogRecords([untimed], context()).events[0]?.ts).toBe(
      '2026-10-08T00:00:00.000Z',
    );
  });

  it('maps query_source [Inferred]', () => {
    expect(claudeQuerySource(undefined, undefined)).toBe('main');
    expect(claudeQuerySource('sdk', undefined)).toBe('main');
    expect(claudeQuerySource('repl_main_thread', undefined)).toBe('main');
    expect(claudeQuerySource('agent:custom', undefined)).toBe('subagent');
    expect(claudeQuerySource('sdk', 'Explore')).toBe('subagent');
    expect(claudeQuerySource('compact', undefined)).toBe('auxiliary');
  });

  it('has the dedupe key of the transcript copy of the same requests (D15)', async () => {
    const otel = mapLogRecords(decodeJson(fixtureJson()), context()).events;
    const stat = statSync(FIXTURE_TRANSCRIPT);
    const transcript = [];
    for await (const chunk of claudeAdapter.tail(
      {
        runtime: 'claude',
        profileKey: 'fixture',
        path: FIXTURE_TRANSCRIPT,
        sessionId: JSON_SESSION,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      },
      freshState(),
      { projects: [] },
    )) {
      transcript.push(...chunk.events.filter((e) => e.type === 'llm.request'));
    }
    const key = (e: { session?: { id: string }; data: unknown }) =>
      `${e.session?.id}/${(e.data as LlmRequestData).requestId}`;
    expect(transcript.map(key)).toEqual(otel.map(key));
    // The transcript knows the TTL OTel does not: the reason for the flag.
    expect((transcript[1]?.data as LlmRequestData).tokens.cacheWrite1h).toBe(
      155,
    );
    expect((otel[1]?.data as LlmRequestData).tokens.cacheWrite5m).toBe(155);
  });
});

/** Why the Codex tests are skipped; un-skip them with a captured fixture (D13). */
const NO_CODEX_FIXTURE =
  'skipped: no captured Codex OTLP export yet, Codex is not installed on the reference machine (spec 13 D13)';

describe('otlp map — Codex (experimental)', () => {
  it.skip(`maps codex.api_request token counts — ${NO_CODEX_FIXTURE}`, () => {});
  it.skip(`maps codex.sse_event usage — ${NO_CODEX_FIXTURE}`, () => {});
  it.skip(`correlates Codex OTel with its transcript — ${NO_CODEX_FIXTURE}`, () => {});
});

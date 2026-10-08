import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  type LlmRequestData,
  parseSessionEvent,
  type SessionEvent,
  type SessionObservedData,
  type ToolCallData,
  type UnsequencedEvent,
  type WatchedProject,
} from '@agentdock/shared/protocol';
import type { ConfigProfile } from '../../config';
import { freshState, type TranscriptSource } from '../types';
import { claudeAdapter } from './adapter';
import { freshClaudeParserState, parseClaudeLines } from './parse';

const FIXTURES = join(import.meta.dir, 'fixtures');
const PROFILE_DIR = join(FIXTURES, 'profile');
const SESSION = '11111111-1111-4111-8111-111111111111';
const ACME: WatchedProject = { id: 'prj_acme', root: '/srv/dev/acme' };

const profile: ConfigProfile = {
  id: 'claude-fixture',
  runtime: 'claude',
  env: { CLAUDE_CONFIG_DIR: PROFILE_DIR },
  args: [],
};

const sources = () => claudeAdapter.discover(profile, '/nonexistent-home');
const main = () => {
  const found = sources().find((s) => !s.parent);
  if (!found) throw new Error('main transcript not discovered');
  return found;
};
const subagent = () => {
  const found = sources().find((s) => s.parent);
  if (!found) throw new Error('subagent transcript not discovered');
  return found;
};

/** Every event of a transcript, read from its start, validated as on the API. */
const read = async (
  source: TranscriptSource,
  projects: WatchedProject[] = [ACME],
): Promise<SessionEvent[]> => {
  const events: UnsequencedEvent[] = [];
  for await (const chunk of claudeAdapter.tail(source, freshState(), {
    projects,
  })) {
    events.push(...chunk.events);
  }
  return events.map((event, i) => {
    const parsed = parseSessionEvent({ ...event, seq: i + 1 });
    if (!parsed?.ok) throw new Error(`invalid ${event.type}`);
    return parsed.event;
  });
};

const ofType = <T>(events: SessionEvent[], type: string): T[] =>
  events.filter((e) => e.type === type).map((e) => e.data as T);

describe('claude adapter: discovery (D2)', () => {
  it('finds the main transcript and its subagent, with their session ids', () => {
    const found = sources();
    expect(found).toHaveLength(2);
    expect(main()).toMatchObject({
      runtime: 'claude',
      profileKey: 'claude-fixture',
      sessionId: SESSION,
    });
    expect(subagent()).toMatchObject({
      sessionId: 'aaaa1111',
      parent: {
        sessionId: SESSION,
        toolUseId: 'toolu_agent1',
        agentName: 'Explore',
      },
    });
  });

  it('finds nothing for a profile without a projects directory', () => {
    expect(
      claudeAdapter.discover(
        { ...profile, env: { CLAUDE_CONFIG_DIR: '/nonexistent' } },
        '/nonexistent-home',
      ),
    ).toEqual([]);
  });
});

describe('claude adapter: parsing (D3)', () => {
  it('emits one turn per user prompt, each started then finished', async () => {
    const events = await read(main());
    const turns = events
      .filter((e) => e.type === 'turn.started' || e.type === 'turn.finished')
      .map((e) => [e.type, (e.data as { promptId: string }).promptId, e.ts]);
    expect(turns).toEqual([
      ['turn.started', 'p-1', '2026-10-01T10:00:00.000Z'],
      ['turn.finished', 'p-1', '2026-10-01T10:00:34.000Z'],
      ['turn.started', 'p-2', '2026-10-01T10:05:00.000Z'],
      ['turn.finished', 'p-2', '2026-10-01T10:05:06.000Z'],
    ]);
  });

  it('emits one llm.request per distinct requestId with the six buckets', async () => {
    const requests = ofType<LlmRequestData>(await read(main()), 'llm.request');
    expect(requests.map((r) => r.requestId)).toEqual([
      'req_A',
      'req_B',
      'req_C',
      'req_D',
    ]);
    const [a, b, c, d] = requests;
    expect(a).toEqual({
      requestId: 'req_A',
      promptId: 'p-1',
      model: 'claude-opus-5-5',
      tokens: {
        input: 10,
        output: 300,
        cacheRead: 1000,
        cacheWrite5m: 200,
        cacheWrite1h: 300,
        reasoning: 120,
      },
      durationMs: 2000,
      durationApprox: true,
      stopReason: 'tool_use',
      querySource: 'main',
    });
    expect(b.tokens).toEqual({
      input: 5,
      output: 50,
      cacheRead: 2000,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      reasoning: 0,
    });
    // No TTL split: the write is a 5-minute one, the API's default.
    expect(c.tokens.cacheWrite5m).toBe(40);
    expect(c.stopReason).toBe('end_turn');
    expect(d).toMatchObject({ model: 'claude-sonnet-5-5', promptId: 'p-2' });
  });

  it('yields exactly one request for assistant lines repeating a requestId (D4)', async () => {
    const requests = ofType<LlmRequestData>(await read(main()), 'llm.request');
    expect(requests.filter((r) => r.requestId === 'req_A')).toHaveLength(1);
  });

  it('sends a request again when a later line of it carries newer usage — the last wins', () => {
    const line = (output: number) =>
      JSON.stringify({
        type: 'assistant',
        requestId: 'req_X',
        cwd: '/srv/dev/acme',
        timestamp: '2026-10-01T10:00:00.000Z',
        message: { id: 'msg_X', model: 'm', usage: { output_tokens: output } },
      });
    const { events } = parseClaudeLines(
      [line(5), line(5), line(9)],
      { observed: null, parser: freshClaudeParserState() },
      { source: main(), projects: [] },
    );
    const outputs = events
      .filter((e) => e.type === 'llm.request')
      .map((e) => (e.data as LlmRequestData).tokens.output);
    expect(outputs).toEqual([5, 9]);
  });

  it('skips the messages Claude Code writes itself (<synthetic>)', async () => {
    const requests = ofType<LlmRequestData>(await read(main()), 'llm.request');
    expect(requests.some((r) => r.model === '<synthetic>')).toBe(false);
  });

  it('pairs each tool_use with its tool_result', async () => {
    const tools = ofType<ToolCallData>(await read(main()), 'tool.call');
    expect(tools).toEqual([
      {
        toolUseId: 'toolu_bash1',
        promptId: 'p-1',
        tool: 'Bash',
        startedAt: '2026-10-01T10:00:02.200Z',
      },
      {
        toolUseId: 'toolu_bash1',
        promptId: 'p-1',
        tool: 'Bash',
        startedAt: '2026-10-01T10:00:02.200Z',
        endedAt: '2026-10-01T10:00:05.000Z',
        ok: true,
        durationMs: 2800,
      },
      {
        toolUseId: 'toolu_agent1',
        promptId: 'p-1',
        tool: 'Agent',
        startedAt: '2026-10-01T10:00:07.000Z',
      },
      {
        toolUseId: 'toolu_agent1',
        promptId: 'p-1',
        tool: 'Agent',
        startedAt: '2026-10-01T10:00:07.000Z',
        endedAt: '2026-10-01T10:00:30.000Z',
        ok: true,
        durationMs: 23000,
        childSessionId: 'aaaa1111',
      },
      {
        toolUseId: 'toolu_read1',
        promptId: 'p-2',
        tool: 'Read',
        startedAt: '2026-10-01T10:05:04.000Z',
      },
      {
        toolUseId: 'toolu_read1',
        promptId: 'p-2',
        tool: 'Read',
        startedAt: '2026-10-01T10:05:04.000Z',
        endedAt: '2026-10-01T10:05:05.000Z',
        ok: false,
        durationMs: 1000,
      },
    ]);
  });

  it('observes the session with its correlation, and again when the custom title appears', async () => {
    const observed = ofType<SessionObservedData>(
      await read(main()),
      'session.observed',
    );
    const first: SessionObservedData = {
      profileKey: 'claude-fixture',
      cwd: '/srv/dev/.wt-acme-i42',
      gitBranch: 'feat/42-thing',
      startedAt: '2026-10-01T10:00:00.000Z',
      parsed: true,
      projectId: 'prj_acme',
      slot: 'i42',
    };
    expect(observed).toEqual([first, { ...first, title: 'Fixture session' }]);
  });

  it('has no project for a session no watched project contains', async () => {
    const observed = ofType<SessionObservedData>(
      await read(main(), [{ id: 'prj_other', root: '/srv/dev/other' }]),
      'session.observed',
    );
    expect(observed[0].projectId).toBeUndefined();
    expect(observed[0].slot).toBeUndefined();
  });
});

describe('claude adapter: subagents', () => {
  it('observes the subagent as a child of the tool call that spawned it', async () => {
    const events = await read(subagent());
    expect(events[0].session).toEqual({ runtime: 'claude', id: 'aaaa1111' });
    const [observed] = ofType<SessionObservedData>(events, 'session.observed');
    expect(observed.parent).toEqual({
      sessionId: SESSION,
      toolUseId: 'toolu_agent1',
    });
    // …which the parent's tool call names from its side as well.
    const spawn = ofType<ToolCallData>(await read(main()), 'tool.call').find(
      (t) => t.childSessionId,
    );
    expect(spawn?.childSessionId).toBe(events[0].session.id);
  });

  it('attributes its requests to the subagent', async () => {
    const requests = ofType<LlmRequestData>(
      await read(subagent()),
      'llm.request',
    );
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request).toMatchObject({
        querySource: 'subagent',
        agentName: 'Explore',
      });
    }
    expect(requests[0].tokens.cacheWrite1h).toBe(800);
  });
});

describe('claude adapter: no content leaves the runner (D9)', () => {
  it('emits no sentinel string from a prompt, response, thinking, tool argument or output', async () => {
    const events = [...(await read(main())), ...(await read(subagent()))];
    expect(events.length).toBeGreaterThan(20);
    const wire = JSON.stringify(events);
    expect(wire).not.toContain('SENTINEL');
  });

  it('keeps the fixtures synthetic: sentinels present, no real home path or email', () => {
    const files = readdirSync(FIXTURES, { recursive: true, encoding: 'utf8' })
      .map((name) => join(FIXTURES, name))
      .filter((path) => statSync(path).isFile());
    const text = files.map((path) => readFileSync(path, 'utf8')).join('\n');
    expect(text).toContain('SENTINEL_PROMPT_ONE');
    expect(text).not.toMatch(/\/home\/|\/Users\//);
    expect(text).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
  });
});

import { describe, expect, it } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { LocalResult } from '../local/types';
import { buildMcpServer, MCP_SERVER_NAME } from './server';

interface Call {
  method: string;
  args: Record<string, unknown>;
}

const connect = async (
  answer: (call: Call) => LocalResult<unknown>,
): Promise<{ client: Client; calls: Call[] }> => {
  const calls: Call[] = [];
  const server = buildMcpServer(async (method, args) => {
    calls.push({ method, args });
    return answer({ method, args });
  });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return { client, calls };
};

const text = (result: unknown): string =>
  (result as { content: { text: string }[] }).content[0]?.text ?? '';

describe('agentdock MCP server (spec 201 D20)', () => {
  it('answers tools/list with the fourteen tools, named agentdock', async () => {
    const { client } = await connect(() => ({ ok: true, data: {} }));
    expect(client.getServerVersion()?.name).toBe(MCP_SERVER_NAME);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(
      [
        'status',
        'queue',
        'budget',
        'approvals',
        'activity',
        'sessions',
        'create_issue',
        'note',
        'handoff',
        'request_action',
        'action_status',
        'finish_card',
        'track_card',
        'away',
      ].sort(),
    );
    expect(tools.every((tool) => tool.description)).toBe(true);
  });

  it('maps every tool 1:1 to its local method (D7)', async () => {
    const { client, calls } = await connect(() => ({ ok: true, data: {} }));
    const cases: [string, Record<string, unknown>, Call][] = [
      ['status', {}, { method: 'fleet.status', args: {} }],
      ['queue', { limit: 5 }, { method: 'queue.list', args: { limit: 5 } }],
      ['budget', {}, { method: 'budget.remaining', args: {} }],
      ['approvals', {}, { method: 'approvals.list', args: {} }],
      ['activity', {}, { method: 'activity.recent', args: {} }],
      [
        'sessions',
        { limit: 3 },
        { method: 'sessions.recent', args: { limit: 3 } },
      ],
      [
        'note',
        { text: 'hello' },
        { method: 'activity.note', args: { text: 'hello' } },
      ],
      [
        'handoff',
        { title: 't', body: 'b', branch: 'feat/x' },
        {
          method: 'handoff.create',
          args: { title: 't', body: 'b', branch: 'feat/x' },
        },
      ],
      [
        'request_action',
        { kind: 'pr_approve', args: { pr: 7 }, summary: 'Approve PR 7' },
        {
          method: 'action.request',
          args: {
            kind: 'pr_approve',
            args: { pr: 7 },
            summary: 'Approve PR 7',
          },
        },
      ],
      [
        'action_status',
        { id: 'ar_1' },
        { method: 'action.status', args: { id: 'ar_1' } },
      ],
      ['away', { on: true }, { method: 'away.set', args: { on: true } }],
      [
        'track_card',
        { title: 'Fix login', body: 'Redirect loops.', kind: 'bug' },
        {
          method: 'card.track',
          args: { title: 'Fix login', body: 'Redirect loops.', kind: 'bug' },
        },
      ],
      [
        'track_card',
        { title: 'Add export' },
        { method: 'card.track', args: { title: 'Add export' } },
      ],
      [
        'finish_card',
        { summary: 'Added the export.' },
        { method: 'card.finish', args: { summary: 'Added the export.' } },
      ],
    ];
    for (const [name, args, expected] of cases) {
      calls.length = 0;
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError).toBeFalsy();
      expect(calls).toEqual([expected]);
    }
  });

  it('create_issue with queue: true asks for issue.create with queue: true', async () => {
    const { client, calls } = await connect(() => ({
      ok: true,
      data: {
        number: 12,
        url: 'https://github.com/o/r/issues/12',
        queued: true,
      },
    }));
    const result = await client.callTool({
      name: 'create_issue',
      arguments: {
        title: 'Fix it',
        body: 'Details',
        labels: ['bug'],
        queue: true,
      },
    });
    expect(calls).toEqual([
      {
        method: 'issue.create',
        args: {
          title: 'Fix it',
          body: 'Details',
          labels: ['bug'],
          queue: true,
        },
      },
    ]);
    expect(result.structuredContent).toEqual({
      number: 12,
      url: 'https://github.com/o/r/issues/12',
      queued: true,
    });
    expect(text(result)).toContain('"queued": true');
  });

  it('turns a local error into an MCP tool error carrying its code', async () => {
    for (const code of ['runner_offline', 'no_project'] as const) {
      const { client } = await connect(() => ({
        ok: false,
        error: { code, message: 'nope' },
      }));
      const result = await client.callTool({ name: 'status', arguments: {} });
      expect(result.isError).toBe(true);
      expect(text(result)).toBe(`${code}: nope`);
      expect(result.structuredContent).toEqual({
        error: { code, message: 'nope' },
      });
    }
  });

  it('finish_card outside a card session is a tool error not_a_card_session (#242)', async () => {
    const { client, calls } = await connect(() => ({
      ok: false,
      error: {
        code: 'not_a_card_session',
        message: 'this session is not a board card worker',
      },
    }));
    const result = await client.callTool({
      name: 'finish_card',
      arguments: { summary: 'Done.' },
    });
    expect(calls).toEqual([
      { method: 'card.finish', args: { summary: 'Done.' } },
    ]);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      error: {
        code: 'not_a_card_session',
        message: 'this session is not a board card worker',
      },
    });
  });

  it('track_card from a non-manual session is a tool error not_a_manual_session (#282)', async () => {
    const { client, calls } = await connect(() => ({
      ok: false,
      error: {
        code: 'not_a_manual_session',
        message: 'only a person’s own session can track a card',
      },
    }));
    const result = await client.callTool({
      name: 'track_card',
      arguments: { title: 'Fix login' },
    });
    expect(calls).toEqual([
      { method: 'card.track', args: { title: 'Fix login' } },
    ]);
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('not_a_manual_session');
  });

  it('track_card rejects an empty title and an unknown kind before the daemon', async () => {
    const { client, calls } = await connect(() => ({ ok: true, data: {} }));
    for (const args of [
      { title: '' },
      { title: 'x', kind: 'chore' },
      { title: 'x'.repeat(201) },
    ]) {
      const result = await client
        .callTool({ name: 'track_card', arguments: args })
        .catch(() => ({ isError: true }));
      expect(result.isError).toBe(true);
    }
    expect(calls).toEqual([]);
  });

  it('rejects arguments outside the tool schema before calling the daemon', async () => {
    const { client, calls } = await connect(() => ({ ok: true, data: {} }));
    const result = await client
      .callTool({ name: 'note', arguments: { text: '' } })
      .catch(() => ({ isError: true }));
    expect(result.isError).toBe(true);
    expect(calls).toEqual([]);
  });
});

import { describe, expect, it } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CARD_ESCALATION_NOTE_MAX } from '@nautelle/shared';
import type { LocalResult } from '../local/types';
import { buildMcpServer } from './server';
import { ESCALATE_CARD_MCP_TOOL, MCP_TOOLS } from './tools';

interface Call {
  method: string;
  args: Record<string, unknown>;
}

const connect = async (
  answer: (call: Call) => LocalResult<unknown>,
  escalate?: boolean,
): Promise<{ client: Client; calls: Call[] }> => {
  const calls: Call[] = [];
  const server = buildMcpServer(
    async (method, args) => {
      calls.push({ method, args });
      return answer({ method, args });
    },
    escalate === undefined ? {} : { escalate },
  );
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return { client, calls };
};

const names = async (client: Client): Promise<string[]> =>
  (await client.listTools()).tools.map((tool) => tool.name);

describe('escalate_card (#750 D8)', () => {
  it('is not one of the tools every session gets', () => {
    expect(MCP_TOOLS.map((tool) => tool.name)).not.toContain('escalate_card');
  });

  it('is listed only on a round launched with escalate', async () => {
    for (const escalate of [undefined, false]) {
      const { client } = await connect(
        () => ({ ok: true, data: {} }),
        escalate,
      );
      expect(await names(client)).not.toContain('escalate_card');
    }
    const { client } = await connect(() => ({ ok: true, data: {} }), true);
    const listed = await names(client);
    expect(listed).toContain('escalate_card');
    expect(listed).toContain('finish_card');
    expect(listed).toHaveLength(MCP_TOOLS.length + 2);
  });

  it('calls card.escalate with the reason and the note', async () => {
    const { client, calls } = await connect(
      () => ({
        ok: true,
        data: { number: 7, escalated: true, relaunched: true },
      }),
      true,
    );
    const result = await client.callTool({
      name: 'escalate_card',
      arguments: { reason: 'misclassified', note: 'The card needs a schema.' },
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      number: 7,
      escalated: true,
      relaunched: true,
    });
    expect(calls).toEqual([
      {
        method: 'card.escalate',
        args: { reason: 'misclassified', note: 'The card needs a schema.' },
      },
    ]);
  });

  it('turns not_escalatable into a tool error carrying its code', async () => {
    const { client } = await connect(
      () => ({
        ok: false,
        error: { code: 'not_escalatable', message: 'already escalated' },
      }),
      true,
    );
    const result = await client.callTool({
      name: 'escalate_card',
      arguments: { reason: 'gave_up', note: 'Stuck.' },
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      error: { code: 'not_escalatable', message: 'already escalated' },
    });
  });

  it('rejects an unknown reason, an empty note and a note over the limit before the daemon', async () => {
    const { client, calls } = await connect(
      () => ({ ok: true, data: {} }),
      true,
    );
    for (const args of [
      { reason: 'bored', note: 'x' },
      { reason: 'gave_up', note: '   ' },
      { reason: 'gave_up', note: 'x'.repeat(CARD_ESCALATION_NOTE_MAX + 1) },
    ]) {
      const result = await client.callTool({
        name: 'escalate_card',
        arguments: args,
      });
      expect(result.isError).toBe(true);
    }
    expect(calls).toEqual([]);
  });

  it('describes the tool for the worker', () => {
    expect(ESCALATE_CARD_MCP_TOOL.description).toContain('Opus');
  });
});

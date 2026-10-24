import { describe, expect, it } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  CARD_ESCALATION_NOTE_MAX,
  DESIGN_COMMENT_MAX,
  REVIEW_FINDINGS_MAX,
  REVIEW_REPORT_TOOL,
} from '@nautelle/shared';
import {
  LOCAL_STACK_STAGES_MAX,
  localCardReviewReportArgsSchema,
  localMethods,
} from '@nautelle/shared/protocol';
import { z } from 'zod';
import type { LocalResult } from '../local/types';
import { buildMcpServer, mcpToolsOf } from './server';
import {
  ESCALATE_CARD_MCP_TOOL,
  MCP_TOOLS,
  type McpToolDefinition,
  REPORT_REVIEW_MCP_TOOL,
  REVIEW_SESSION_TOOLS,
} from './tools';

interface Call {
  method: string;
  args: Record<string, unknown>;
}

const connect = async (
  answer: (call: Call) => LocalResult<unknown>,
  escalate?: boolean,
  review?: boolean,
): Promise<{ client: Client; calls: Call[] }> => {
  const calls: Call[] = [];
  const server = buildMcpServer(
    async (method, args) => {
      calls.push({ method, args });
      return answer({ method, args });
    },
    {
      ...(escalate === undefined ? {} : { escalate }),
      ...(review === undefined ? {} : { review }),
    },
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

describe('report_review (#884)', () => {
  const report = {
    findings: [
      {
        severity: 'blocking',
        file: 'src/a.ts',
        line: 12,
        title: 'The guard is inverted',
        body: 'It lets every caller through.',
      },
      { severity: 'nit', title: 'Naming', body: 'Rename x.' },
    ],
    summary: 'One blocking finding.',
  };

  it('is not one of the tools every session gets', () => {
    expect(MCP_TOOLS.map((tool) => tool.name)).not.toContain(
      REVIEW_REPORT_TOOL,
    );
    expect(REPORT_REVIEW_MCP_TOOL.name).toBe('report_review');
  });

  it('is listed only in a review session, with the read tools and nothing that changes a card', async () => {
    for (const review of [undefined, false]) {
      const { client } = await connect(
        () => ({ ok: true, data: {} }),
        undefined,
        review,
      );
      expect(await names(client)).not.toContain('report_review');
    }
    const { client } = await connect(
      () => ({ ok: true, data: {} }),
      true,
      true,
    );
    const listed = await names(client);
    expect(listed).toContain('report_review');
    for (const hidden of [
      'finish_card',
      'escalate_card',
      'take_card',
      'track_card',
      'card_create',
      'card_move',
      'create_issue',
      'handoff',
    ]) {
      expect(listed).not.toContain(hidden);
    }
    expect([...listed].sort()).toEqual(
      ['resume_context', 'report_review', ...REVIEW_SESSION_TOOLS].sort(),
    );
  });

  it('offers only tools that exist', () => {
    const all: string[] = MCP_TOOLS.map((tool) => tool.name);
    for (const name of REVIEW_SESSION_TOOLS) expect(all).toContain(name);
    expect(mcpToolsOf({ review: true })).toHaveLength(
      REVIEW_SESSION_TOOLS.length + 1,
    );
  });

  it('calls card.reviewReport with the findings and the summary', async () => {
    const { client, calls } = await connect(
      () => ({
        ok: true,
        data: { number: 7, recorded: true, blocking: 1, nits: 1 },
      }),
      undefined,
      true,
    );
    const result = await client.callTool({
      name: 'report_review',
      arguments: report,
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      number: 7,
      recorded: true,
      blocking: 1,
      nits: 1,
    });
    expect(calls).toEqual([{ method: 'card.reviewReport', args: report }]);
  });

  it('turns not_a_review_session into a tool error carrying its code', async () => {
    const { client } = await connect(
      () => ({
        ok: false,
        error: { code: 'not_a_review_session' },
      }),
      undefined,
      true,
    );
    const result = await client.callTool({
      name: 'report_review',
      arguments: { findings: [] },
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      error: { code: 'not_a_review_session' },
    });
  });

  it('rejects a bad severity, a missing title and too many findings before the daemon', async () => {
    const { client, calls } = await connect(
      () => ({ ok: true, data: {} }),
      undefined,
      true,
    );
    const finding = { severity: 'nit', title: 'x', body: '' };
    for (const args of [
      { findings: [{ ...finding, severity: 'major' }] },
      { findings: [{ severity: 'nit', body: '' }] },
      { findings: [{ ...finding, line: 0 }] },
      {
        findings: Array.from(
          { length: REVIEW_FINDINGS_MAX + 1 },
          () => finding,
        ),
      },
    ]) {
      const result = await client.callTool({
        name: 'report_review',
        arguments: args,
      });
      expect(result.isError).toBe(true);
    }
    expect(calls).toEqual([]);
  });

  it('accepts what the daemon accepts', () => {
    const input = z.object(REPORT_REVIEW_MCP_TOOL.input);
    expect(input.safeParse(report).success).toBe(true);
    expect(localCardReviewReportArgsSchema.safeParse(report).success).toBe(
      true,
    );
  });

  it('describes the tool for the reviewer', () => {
    expect(REPORT_REVIEW_MCP_TOOL.description).toContain('once');
    expect(REPORT_REVIEW_MCP_TOOL.description).toContain('do not edit');
  });
});

describe('stack, design and dependency tools (C-377)', () => {
  const tools = [
    'stack_create',
    'stack_add_card',
    'stack_remove_card',
    'stack_update',
    'stack_run',
    'stack_stop',
    'stack_design',
    'card_design',
    'card_depend',
    'card_undepend',
  ];
  const toolOf = (name: string): McpToolDefinition => {
    const tool = (MCP_TOOLS as readonly McpToolDefinition[]).find(
      (t) => t.name === name,
    );
    if (!tool) throw new Error(`no tool ${name}`);
    return tool;
  };

  it('are every session’s tools but a review session’s, and say who may call them', () => {
    const all: string[] = MCP_TOOLS.map((tool) => tool.name);
    for (const name of tools) {
      expect(all).toContain(name);
      expect(REVIEW_SESSION_TOOLS as readonly string[]).not.toContain(name);
      expect(toolOf(name).description).toContain('not_a_manual_session');
    }
    for (const name of ['stack_design', 'card_design']) {
      expect(toolOf(name).description).toContain('needs_person');
    }
    expect(toolOf('board_list').description).toContain('stacks');
  });

  it('accept what the daemon accepts', () => {
    const cases: [string, Record<string, unknown>][] = [
      [
        'stack_create',
        {
          title: 'Export',
          body: 'CSV export.',
          design: true,
          stages: [{ title: 'API', cards: [1, 2] }, { cards: [3] }],
        },
      ],
      ['stack_add_card', { stack: 1, card: 4, stage: 2 }],
      ['stack_remove_card', { stack: 1, card: 4 }],
      [
        'stack_update',
        { stack: 1, title: 'CSV', stages: [{ position: 1, title: '' }] },
      ],
      ['stack_run', { stack: 1 }],
      ['stack_stop', { stack: 1 }],
      ['stack_design', { stack: 1, action: 'generate' }],
      [
        'stack_design',
        { stack: 1, action: 'revise', comments: ['Wider.'], revisionId: 'r1' },
      ],
      ['card_design', { card: 3, action: 'approve', revisionId: 'r1' }],
      ['card_depend', { card: 3, dependsOn: 2 }],
      ['card_undepend', { card: 3, dependsOn: 2 }],
    ];
    for (const [name, args] of cases) {
      const tool = toolOf(name);
      expect(z.object(tool.input).safeParse(args).success).toBe(true);
      expect(localMethods[tool.method].args.safeParse(args).success).toBe(true);
    }
    for (const [name, args] of [
      ['stack_design', { stack: 1, action: 'status' }],
      ['card_design', { card: 3, action: 'status' }],
    ] as const) {
      const call = toolOf(name).route?.(args);
      if (!call) throw new Error(`${name} status is not routed`);
      expect(localMethods[call.method].args.safeParse(call.args).success).toBe(
        true,
      );
    }
  });

  it('reject a bad input before the daemon', async () => {
    const { client, calls } = await connect(() => ({ ok: true, data: {} }));
    const cases: [string, Record<string, unknown>][] = [
      ['stack_create', { title: 'x', stages: [] }],
      ['stack_create', { title: 'x', stages: [{ cards: [] }] }],
      ['stack_create', { title: ' ', stages: [{ cards: [1, 2] }] }],
      [
        'stack_create',
        {
          title: 'x',
          stages: Array.from(
            { length: LOCAL_STACK_STAGES_MAX + 1 },
            (_, i) => ({
              cards: [i + 1],
            }),
          ),
        },
      ],
      ['stack_add_card', { stack: 1, card: 4 }],
      ['stack_add_card', { stack: 0, card: 4, stage: 0 }],
      ['stack_update', { stack: 1, stages: [] }],
      ['stack_design', { stack: 1, action: 'merge' }],
      ['stack_design', { stack: 1, action: 'revise', comments: [] }],
      ['card_design', { card: 3, action: 'revise', comments: ['  '] }],
      [
        'card_design',
        {
          card: 3,
          action: 'revise',
          comments: ['x'.repeat(DESIGN_COMMENT_MAX + 1)],
        },
      ],
      ['card_depend', { card: 3 }],
      ['card_undepend', { card: 3, dependsOn: 1.5 }],
    ];
    for (const [name, args] of cases) {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError).toBe(true);
    }
    expect(calls).toEqual([]);
  });

  it('pass a refusal on unchanged', async () => {
    const { client } = await connect(() => ({
      ok: false,
      error: { code: 'needs_person', message: 'approve it in the web app' },
    }));
    const result = await client.callTool({
      name: 'stack_design',
      arguments: { stack: 1, action: 'approve' },
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      error: { code: 'needs_person', message: 'approve it in the web app' },
    });
  });
});

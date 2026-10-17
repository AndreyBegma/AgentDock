import type { CommandName } from '@agentdock/shared/protocol';
import type { BudgetGate } from '../../budgets/budget-gate';
import type { PrismaService } from '../../database/prisma.service';
import type { RuntimeProfileResolver } from '../../readiness';
import type { RunnerCommandService } from '../../runners/runner-command.service';
import type { RunnerPresence } from '../../runners/runner-presence';
import { systemPrompt } from '../prompts';
import { AssistantCodeTools, CODE_TOOL_ERROR } from './code-tools';
import {
  type AssistantToolContext,
  AssistantToolError,
  AssistantToolRegistry,
} from './registry';

const PROJECT = {
  id: 'prj_dock',
  displayName: 'AgentDock',
  repo: 'acme/agentdock',
  runnerId: 'run_desk',
  role: 'viewer' as const,
};

const setup = (
  options: {
    connected?: boolean;
    support?: 'supported' | 'missing' | 'disabled' | 'unknown';
    reply?: unknown;
    runtime?: 'claude' | 'codex';
    budget?: boolean;
  } = {},
) => {
  const registry = new AssistantToolRegistry();
  const runs: { create: unknown[]; update: unknown[] } = {
    create: [],
    update: [],
  };
  const prisma = {
    project: {
      findUniqueOrThrow: jest.fn(async () => ({
        rootPath: '/srv/dev/agentdock',
        defaultProfileId: 'prof_1',
      })),
    },
    run: {
      create: jest.fn(async (args: unknown) => {
        runs.create.push(args);
        return { id: 'run_code_1' };
      }),
      findUnique: jest.fn(async () => ({ startedAt: new Date() })),
      updateMany: jest.fn(async (args: unknown) => {
        runs.update.push(args);
        return { count: 1 };
      }),
    },
  } as unknown as PrismaService;
  const send = jest.fn(
    async (_runner: string, _name: CommandName, _args: unknown) =>
      options.reply ?? { status: 'unknown' },
  );
  const commands = { send } as unknown as RunnerCommandService;
  const presence = {
    isConnected: () => options.connected ?? true,
    commandSupport: () => options.support ?? 'supported',
  } as unknown as RunnerPresence;
  const profiles = {
    resolve: async () => ({
      ok: true,
      profile: { key: 'claude-work', runtime: options.runtime ?? 'claude' },
    }),
  } as unknown as RuntimeProfileResolver;
  const budgets = {
    check: async () =>
      options.budget === false
        ? {
            allowed: false,
            budgetId: 'b1',
            scope: 'project',
            resetsAt: new Date('2026-11-01T00:00:00Z'),
          }
        : { allowed: true },
  } as unknown as BudgetGate;
  const tools = new AssistantCodeTools(
    registry,
    prisma,
    commands,
    presence,
    profiles,
    budgets,
  );
  tools.onModuleInit();
  const ctx = {
    user: { id: 'usr_alice', email: 'alice@example.com', role: 'operator' },
    ctx: { actor: { type: 'user', id: 'usr_alice' } },
    conversationId: 'conv_1',
    provider: 'anthropic',
    project: async () => PROJECT,
    bindProject: async () => PROJECT,
  } as unknown as AssistantToolContext;
  const run = (name: string, input: object) => {
    const tool = registry.get(name);
    if (!tool) throw new Error(`no tool ${name}`);
    return tool.run(tool.input.parse(input), ctx);
  };
  const refusal = (work: Promise<unknown>) =>
    work.then(
      () => null,
      (error: unknown) =>
        error instanceof AssistantToolError
          ? { code: error.code, message: error.message }
          : { code: 'thrown', message: String(error) },
    );
  return { registry, send, runs, run, refusal };
};

describe('assistant code tools (#622)', () => {
  it('offers search_code and read_file with Anthropic only; ask_code_agent with every provider', () => {
    const { registry } = setup();
    const names = (provider: 'anthropic' | 'openai' | 'xai') =>
      registry.definitions(provider).map((d) => d.name);
    expect(names('anthropic')).toEqual([
      'search_code',
      'read_file',
      'ask_code_agent',
    ]);
    expect(names('openai')).toEqual(['ask_code_agent']);
    expect(names('xai')).toEqual(['ask_code_agent']);
    // A tool not offered cannot be called by name either.
    expect(registry.get('read_file', 'openai')).toBeUndefined();
    expect(registry.get('ask_code_agent', 'openai')).toBeDefined();
  });

  it('returns a typed runner_offline error and sends nothing when the runner is offline', async () => {
    const t = setup({ connected: false });
    for (const [name, input] of [
      ['search_code', { query: 'computeInvoice' }],
      ['read_file', { path: 'src/app.ts' }],
      ['ask_code_agent', { question: 'Where is X implemented?' }],
    ] as const) {
      const refused = await t.refusal(t.run(name, input));
      expect(refused?.code).toBe(CODE_TOOL_ERROR.runnerOffline);
      expect(refused?.message).toContain('offline');
    }
    expect(t.send).not.toHaveBeenCalled();
    expect(t.runs.create).toHaveLength(0);
  });

  it('refuses a runner older than the commands as runner_unsupported', async () => {
    const t = setup({ support: 'missing' });
    expect((await t.refusal(t.run('search_code', { query: 'x' })))?.code).toBe(
      CODE_TOOL_ERROR.runnerUnsupported,
    );
  });

  it("sends repo.search to the project's runner on its checkout and returns the matches", async () => {
    const t = setup({
      reply: {
        status: 'ok',
        rttMs: 4,
        output: {
          matches: [
            {
              path: 'src/billing/invoice.ts',
              line: 1,
              text: 'export function computeInvoice',
            },
          ],
          truncated: false,
          withheld: 1,
        },
      },
    });
    const result = await t.run('search_code', { query: 'computeInvoice' });
    expect(t.send).toHaveBeenCalledWith(
      'run_desk',
      'repo.search',
      {
        projectId: 'prj_dock',
        root: '/srv/dev/agentdock',
        query: 'computeInvoice',
      },
      expect.objectContaining({ role: 'viewer' }),
    );
    expect(result.summary).toBe(
      'Searched AgentDock for "computeInvoice" — 1 matches in 1 files',
    );
  });

  it("passes the runner's refusals on with their codes", async () => {
    for (const code of [
      'policy_refused',
      'path_not_allowed',
      'path_not_found',
    ]) {
      const t = setup({
        reply: {
          status: 'error',
          error: { code, message: `refused: ${code}` },
        },
      });
      expect(await t.refusal(t.run('read_file', { path: '../x' }))).toEqual({
        code,
        message: `refused: ${code}`,
      });
    }
    const t = setup({
      reply: { status: 'error', error: { code: 'internal' } },
    });
    expect((await t.refusal(t.run('read_file', { path: 'a' })))?.code).toBe(
      CODE_TOOL_ERROR.runnerError,
    );
  });

  it('runs ask_code_agent as a code_ask run, keeping the question out of the audit args', async () => {
    const t = setup({
      reply: {
        status: 'ok',
        rttMs: 9,
        output: { answer: 'In `src/app.ts:3`.', truncated: false },
      },
    });
    const result = await t.run('ask_code_agent', {
      question: 'Where is the invoice computed?',
    });
    expect(result.data).toEqual({
      answer: 'In `src/app.ts:3`.',
      truncated: false,
    });
    const [, name, args, options] = t.send.mock.calls[0] as unknown as [
      string,
      string,
      Record<string, unknown>,
      { auditArgs: object },
    ];
    expect(name).toBe('code.ask');
    expect(args).toMatchObject({
      runId: 'run_code_1',
      profileKey: 'claude-work',
      question: 'Where is the invoice computed?',
    });
    expect(JSON.stringify(options.auditArgs)).not.toContain('invoice');
    expect(t.runs.create[0]).toMatchObject({
      data: { kind: 'code_ask', status: 'running', triggeredById: 'usr_alice' },
    });
    expect(t.runs.update[0]).toMatchObject({ data: { status: 'succeeded' } });
  });

  it('closes the run as failed when the runner does not answer', async () => {
    const t = setup();
    expect(
      (await t.refusal(t.run('ask_code_agent', { question: 'Where?' })))?.code,
    ).toBe(CODE_TOOL_ERROR.runnerNoAnswer);
    expect(t.runs.update[0]).toMatchObject({ data: { status: 'failed' } });
  });

  it('refuses ask_code_agent without a Claude profile or over a budget, before any run', async () => {
    const codex = setup({ runtime: 'codex' });
    expect(
      (await codex.refusal(codex.run('ask_code_agent', { question: 'Where?' })))
        ?.code,
    ).toBe(CODE_TOOL_ERROR.noClaudeProfile);
    const broke = setup({ budget: false });
    expect(
      (await broke.refusal(broke.run('ask_code_agent', { question: 'Where?' })))
        ?.code,
    ).toBe(CODE_TOOL_ERROR.budgetExceeded);
    expect(codex.runs.create).toHaveLength(0);
    expect(broke.runs.create).toHaveLength(0);
  });

  it('tells the model to read or delegate, cite real paths and never guess', () => {
    const base = {
      now: new Date('2026-10-17T00:00:00Z'),
      user: { email: 'alice@example.com', role: 'operator' },
      project: null,
      ambiguous: [],
    };
    const anthropic = systemPrompt({
      ...base,
      codeTools: { read: true, ask: true },
    });
    expect(anthropic).toContain('search_code');
    expect(anthropic).toContain('ask_code_agent');
    expect(anthropic).toContain('runner_offline');
    expect(anthropic).not.toContain('You cannot read code');
    const openai = systemPrompt({
      ...base,
      codeTools: { read: false, ask: true },
    });
    expect(openai).not.toContain('search_code');
    expect(openai).toContain(
      'Delegate every code question with ask_code_agent',
    );
  });
});

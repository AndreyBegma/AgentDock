import { REVIEW_ERROR, REVIEW_INSTRUCTIONS_MAX } from '@nautelle/shared';
import { HttpException } from '@nestjs/common';
import type { AuditContext } from '../audit/audit.types';
import type { PrismaService } from '../database/prisma.service';
import type { LlmGateway } from '../llm/llm-gateway.service';
import type { LlmStore } from '../llm/llm-store';
import type { RunnerCommandService } from '../runners/runner-command.service';
import type { RunnerPresence } from '../runners/runner-presence';
import {
  PEER_REVIEW_SOURCE_CHARS_MAX,
  PEER_REVIEW_SOURCE_FILES,
  type PeerReviewActor,
  PeerReviewGenerator,
  peerReviewPrompt,
} from './peer-review-generator';

const ctx: AuditContext = { actor: { type: 'user', userId: 'usr_admin' } };
const actor: PeerReviewActor = { userId: 'usr_admin', role: 'admin', ctx };

interface ReadArgs {
  projectId: string;
  root: string;
  path: string;
}

/** The checkout the fake runner reads: path → content. */
type Checkout = Record<string, string>;

const setup = (checkout: Checkout = {}) => {
  const prisma = {
    project: {
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) =>
        where.id === 'prj_a'
          ? {
              id: 'prj_a',
              runnerId: 'run_1',
              rootPath: '/srv/billing',
              displayName: 'Billing',
            }
          : null,
      ),
    },
    projectRule: {
      findMany: jest.fn(async () => [
        { title: 'Use Bun', description: 'Never npm install.' },
        { title: 'Biome only', description: '' },
      ]),
    },
  };
  const commands = {
    send: jest.fn(async (_runnerId: string, _name: string, args: ReadArgs) => {
      const content = checkout[args.path];
      if (content === undefined) {
        return {
          status: 'error' as const,
          error: { code: 'path_not_found' },
        };
      }
      return {
        status: 'ok' as const,
        output: {
          path: args.path,
          content,
          startLine: 1,
          endLine: 1,
          totalLines: 1,
          truncated: false,
        },
        rttMs: 1,
      };
    }),
  };
  const presence = {
    isConnected: jest.fn(() => true),
    commandSupport: jest.fn(() => 'supported'),
  };
  const gateway = {
    complete: jest.fn(async () => ({
      text: '\n# Peer review\n\nUse Bun.\n\n',
      costUsd: 0.01,
    })),
  };
  const llm = {
    defaultModel: jest.fn(async () => ({
      provider: 'anthropic',
      model: 'claude-sonnet-5-5',
    })),
  };
  const generator = new PeerReviewGenerator(
    prisma as unknown as PrismaService,
    commands as unknown as RunnerCommandService,
    presence as unknown as RunnerPresence,
    gateway as unknown as LlmGateway,
    llm as unknown as LlmStore,
  );
  return { generator, prisma, commands, presence, gateway, llm };
};

const errorCode = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(HttpException);
    const http = error as HttpException;
    return {
      status: http.getStatus(),
      code: (http.getResponse() as { error: string }).error,
    };
  }
  throw new Error('expected a rejection');
};

describe('PeerReviewGenerator (#862)', () => {
  it('reads the guidance files on the runner and generates through the gateway', async () => {
    const { generator, commands, gateway } = setup({
      'CLAUDE.md': 'Use Bun. Biome only.',
      'docs/adr/README.md': '| 0010 | Typed runner commands |',
    });

    const text = await generator.generate('prj_a', actor);

    expect(text).toBe('# Peer review\n\nUse Bun.');
    expect(commands.send).toHaveBeenCalledTimes(
      PEER_REVIEW_SOURCE_FILES.length,
    );
    expect(commands.send).toHaveBeenCalledWith(
      'run_1',
      'repo.read',
      expect.objectContaining({
        projectId: 'prj_a',
        root: '/srv/billing',
        path: 'CLAUDE.md',
      }),
      { role: 'admin', ctx },
    );
    expect(gateway.complete).toHaveBeenCalledTimes(1);
    const [call] = gateway.complete.mock.calls[0] as unknown as [
      {
        userId: string;
        feature: string;
        provider: string;
        request: { model: string; messages: { content: string }[] };
      },
    ];
    expect(call).toMatchObject({
      userId: 'usr_admin',
      feature: 'review_instructions',
      provider: 'anthropic',
      request: { model: 'claude-sonnet-5-5' },
    });
    const prompt = call.request.messages[0]?.content ?? '';
    expect(prompt).toContain('## File: CLAUDE.md\n\nUse Bun. Biome only.');
    expect(prompt).toContain('## File: docs/adr/README.md');
    expect(prompt).not.toContain('AGENTS.md');
    expect(prompt).toContain('- Use Bun: Never npm install.');
    expect(prompt).toContain('- Biome only');
  });

  it('keeps the repository text within its budget', async () => {
    const big = 'x'.repeat(PEER_REVIEW_SOURCE_CHARS_MAX - 10);
    const { generator, commands, gateway } = setup({
      'CLAUDE.md': big,
      'AGENTS.md': 'y'.repeat(100),
      'README.md': 'z'.repeat(100),
    });

    await generator.generate('prj_a', actor);

    // The budget is spent after AGENTS.md: nothing more is read.
    const read = commands.send.mock.calls.map((c) => c[2].path);
    expect(read).toEqual(['CLAUDE.md', 'AGENTS.md']);
    const [call] = gateway.complete.mock.calls[0] as unknown as [
      { request: { messages: { content: string }[] } },
    ];
    expect(call.request.messages[0]?.content).toContain(
      `## File: AGENTS.md\n\n${'y'.repeat(10)}`,
    );
    expect(call.request.messages[0]?.content).not.toContain('y'.repeat(11));
  });

  it('caps the instructions', async () => {
    const { generator, gateway } = setup();
    gateway.complete.mockResolvedValueOnce({
      text: 'a'.repeat(REVIEW_INSTRUCTIONS_MAX + 50),
      costUsd: 0,
    });
    const text = await generator.generate('prj_a', actor);
    expect(text).toHaveLength(REVIEW_INSTRUCTIONS_MAX);
  });

  it('refuses an empty answer', async () => {
    const { generator, gateway } = setup();
    gateway.complete.mockResolvedValueOnce({ text: '  \n', costUsd: 0 });
    expect(await errorCode(generator.generate('prj_a', actor))).toEqual({
      status: 502,
      code: REVIEW_ERROR.generationEmpty,
    });
  });

  it('needs a default model before touching the runner', async () => {
    const { generator, llm, commands } = setup();
    llm.defaultModel.mockResolvedValueOnce(null as never);
    expect(await errorCode(generator.generate('prj_a', actor))).toEqual({
      status: 409,
      code: REVIEW_ERROR.noModel,
    });
    expect(commands.send).not.toHaveBeenCalled();
  });

  it('needs the runner online and able to read', async () => {
    const offline = setup();
    offline.presence.isConnected.mockReturnValue(false);
    expect(await errorCode(offline.generator.generate('prj_a', actor))).toEqual(
      { status: 409, code: REVIEW_ERROR.runnerOffline },
    );

    const old = setup();
    old.presence.commandSupport.mockReturnValue('unsupported');
    expect(await errorCode(old.generator.generate('prj_a', actor))).toEqual({
      status: 409,
      code: REVIEW_ERROR.runnerUnsupported,
    });
    expect(old.gateway.complete).not.toHaveBeenCalled();
  });

  it('fails when the runner stops answering', async () => {
    const { generator, commands, gateway } = setup();
    commands.send.mockResolvedValueOnce({ status: 'unknown' } as never);
    expect(await errorCode(generator.generate('prj_a', actor))).toEqual({
      status: 503,
      code: REVIEW_ERROR.runnerNoAnswer,
    });
    expect(gateway.complete).not.toHaveBeenCalled();
  });

  it('is not found for an unknown project', async () => {
    const { generator } = setup();
    expect((await errorCode(generator.generate('prj_x', actor))).status).toBe(
      404,
    );
  });
});

describe('peerReviewPrompt', () => {
  it('says when the repository has no guidance files', () => {
    expect(peerReviewPrompt('Billing', [], [])).toBe(
      'Repository: Billing\n\nThe repository has none of the usual guidance files.',
    );
  });
});

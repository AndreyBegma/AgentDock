import { randomBytes } from 'node:crypto';
import type { CommandName } from '@agentdock/shared/protocol';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../../../app.module';
import { SecretCipher } from '../../../common/crypto';
import { configureApp } from '../../../configure-app';
import { PrismaService } from '../../../database/prisma.service';
import { seedProject } from '../../../fleet/testing/fleet-e2e';
import {
  type CommandSendResult,
  RunnerCommandService,
} from '../../../runners/runner-command.service';
import { RunnerPresence } from '../../../runners/runner-presence';
import type { E2eContext } from '../../../test/e2e-app';

export const TEST_ENCRYPTION_KEY = randomBytes(32).toString('base64');
export const testCipher = (): SecretCipher =>
  SecretCipher.fromKeyText(TEST_ENCRYPTION_KEY);

/** The API with a known encryption key, so trigger secrets can be stored. */
export const createInboundApp = async (
  cipher: SecretCipher = testCipher(),
): Promise<E2eContext> => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(SecretCipher)
    .useValue(cipher)
    .compile();
  const app = moduleRef.createNestApplication<INestApplication<App>>();
  configureApp(app);
  await app.init();
  return {
    app,
    prisma: app.get(PrismaService),
    http: () => request(app.getHttpServer()),
  };
};

export const resetInbound = (prisma: PrismaService) =>
  prisma.$executeRawUnsafe(
    'TRUNCATE TABLE user_sessions, settings, users, runners, projects CASCADE',
  );

/** Audit records written after `from` (the chain is never truncated). */
export const auditSince = async (prisma: PrismaService) => {
  const last = await prisma.auditRecord.findFirst({
    orderBy: { seq: 'desc' },
    select: { seq: true },
  });
  const from = last?.seq ?? 0n;
  return (action: string) =>
    prisma.auditRecord.findMany({
      where: { seq: { gt: from }, action },
      orderBy: { seq: 'asc' },
    });
};

/** A project on a runner with a default profile and the `estimate` skill installed. */
export const seedSkillProject = async (prisma: PrismaService) => {
  const { runnerId, projectId } = await seedProject(prisma, '/srv/a');
  const profile = await prisma.runtimeProfile.create({
    data: {
      runnerId,
      key: 'claude-main',
      runtime: 'claude',
      label: 'Claude',
      env: {},
      args: [],
      authenticated: true,
    },
  });
  await prisma.project.update({
    where: { id: projectId },
    data: { defaultProfileId: profile.id },
  });
  await prisma.installedSkill.create({
    data: {
      runnerId,
      projectId,
      scope: 'project',
      runtime: 'claude',
      name: 'estimate',
      invocation: 'estimate',
      path: '.claude/skills/estimate',
      seenAt: new Date(),
    },
  });
  return { runnerId, projectId };
};

type Answer = CommandSendResult<CommandName>;
export const ok = (output: unknown): Answer =>
  ({ status: 'ok', output, rttMs: 1 }) as Answer;
export const refuse = (code: string): Answer =>
  ({ status: 'error', error: { code } }) as Answer;

/**
 * A fake runner: online unless told otherwise, answering each command from
 * `answers`. Its `send` mock records exactly what would cross the wire.
 */
export const fakeRunner = (ctx: E2eContext) => {
  const state = {
    online: true,
    answers: {
      'skill.run': () => ok({ phase: 'queued' }),
      'orchestrator.start': () =>
        ok({
          session: 'agentdock-orch-a',
          startedAt: new Date().toISOString(),
        }),
    } as Partial<Record<CommandName, () => Answer>>,
  };
  jest
    .spyOn(ctx.app.get(RunnerPresence), 'isConnected')
    .mockImplementation(() => state.online);
  const send = jest
    .spyOn(ctx.app.get(RunnerCommandService), 'send')
    .mockImplementation(async (_runner, name) => {
      const answer = state.answers[name];
      if (!answer) throw new Error(`no answer for ${name}`);
      return answer() as never;
    });
  return {
    state,
    sent: (name: CommandName) =>
      send.mock.calls.filter(([, n]) => n === name).map(([, , args]) => args),
  };
};

import { randomBytes } from 'node:crypto';
import type { Role } from '@agentdock/shared';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Prisma } from '@prisma/client';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../../app.module';
import { SecretCipher } from '../../common/crypto';
import { configureApp } from '../../configure-app';
import { PrismaService } from '../../database/prisma.service';
import { createUser, type E2eContext } from '../../test/e2e-app';
import {
  defaultNotificationOptions,
  NOTIFICATION_OPTIONS,
  type NotificationOptions,
} from '../notification-options';

export const ROOT = '/srv/dev/widget';
export const REPO = 'acme/widget';
/** A fixed key for the suite; the bot-token tests check it seals with this. */
export const TEST_ENCRYPTION_KEY = randomBytes(32).toString('base64');

export interface NotificationsE2e extends E2eContext {
  options: NotificationOptions;
}

/**
 * The app with the notification timers off (tests call `tick()`), a short hole
 * wait, and `cipher` as the `SecretCipher` (default: `TEST_ENCRYPTION_KEY`).
 */
export const createNotificationsApp = async (
  cipher = SecretCipher.fromKeyText(TEST_ENCRYPTION_KEY),
  overrides: Partial<NotificationOptions> = {},
): Promise<NotificationsE2e> => {
  const options: NotificationOptions = {
    ...defaultNotificationOptions,
    autoStart: false,
    holeWaitMs: 1_000,
    ...overrides,
  };
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(NOTIFICATION_OPTIONS)
    .useValue(options)
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
    options,
  };
};

/** Everything a notification test touches, users and runners included. */
export const resetNotifications = (prisma: PrismaService) =>
  prisma.$executeRawUnsafe(
    'TRUNCATE TABLE user_sessions, settings, users, runners, projects, notification_matcher_state CASCADE',
  );

/** A paired runner and a project at `root` on it. */
export const seedRunnerProject = async (
  prisma: PrismaService,
  options: {
    root?: string;
    repo?: string;
    runnerId?: string;
    name?: string;
  } = {},
): Promise<{ runnerId: string; projectId: string }> => {
  const runnerId =
    options.runnerId ??
    (
      await prisma.runner.create({
        data: { name: options.name ?? 'desk', pairedAt: new Date() },
      })
    ).id;
  const root = options.root ?? ROOT;
  const project = await prisma.project.create({
    data: {
      runnerId,
      rootPath: root,
      repo: options.repo ?? REPO,
      displayName: root.slice(root.lastIndexOf('/') + 1),
      baseBranch: 'develop',
      baseSource: 'config',
      hasClaudeMd: true,
      hasAgentsMd: false,
      lastInspectedAt: new Date('2026-10-01T00:00:00Z'),
    },
  });
  return { runnerId, projectId: project.id };
};

/** An active user, optionally a member of `projectId`. */
export const seedUser = async (
  prisma: PrismaService,
  email: string,
  role: Role,
  projectId?: string,
  roleOverride?: Role,
) => {
  const user = await createUser(prisma, email, role);
  if (projectId) {
    await prisma.projectMember.create({
      data: { projectId, userId: user.id, roleOverride: roleOverride ?? null },
    });
  }
  return user;
};

export interface EventFixture {
  type: string;
  data?: Prisma.InputJsonValue;
  slot?: string | null;
  issue?: number | null;
  source?: string;
  root?: string | null;
  repo?: string | null;
  ts?: Date;
  /** An id reserved with `reserveEventIds`; default: the sequence's next. */
  id?: bigint;
}

let seq = 0n;

/** Stores an event as the runner ingest would, straight in `events`. */
export const insertEvent = async (
  prisma: PrismaService,
  runnerId: string,
  event: EventFixture,
): Promise<bigint> => {
  seq += 1n;
  const row = await prisma.event.create({
    data: {
      ...(event.id !== undefined ? { id: event.id } : {}),
      runnerId,
      seq,
      ts: event.ts ?? new Date(),
      type: event.type,
      source: event.source ?? 'runner',
      projectRoot: event.root === undefined ? ROOT : event.root,
      projectRepo: event.repo === undefined ? REPO : event.repo,
      slot: event.slot === undefined ? 'i42-api' : event.slot,
      issue: event.issue === undefined ? 42 : event.issue,
      data: event.data ?? {},
    },
    select: { id: true },
  });
  return row.id;
};

/** Takes `n` ids from `events`' sequence, as concurrent inserts would. */
export const reserveEventIds = async (
  prisma: PrismaService,
  n: number,
): Promise<bigint[]> => {
  const rows = await prisma.$queryRaw<{ id: bigint }[]>`
    SELECT nextval(pg_get_serial_sequence('events', 'id')) AS id
    FROM generate_series(1, ${n})`;
  return rows.map((r) => r.id);
};

export const panePrompt = (
  overrides: Partial<EventFixture> = {},
): EventFixture => ({
  type: 'pane.prompt',
  data: { target: 'slot', dialog: 'trust' },
  ...overrides,
});

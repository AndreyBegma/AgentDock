import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import type { CollectorPollArgs } from '@agentdock/shared/protocol';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../../app.module';
import { SecretCipher } from '../../common/crypto';
import { configureApp } from '../../configure-app';
import { PrismaService } from '../../database/prisma.service';
import type { E2eContext } from '../../test/e2e-app';
import {
  type CollectorPollOutcome,
  CollectorPollSender,
} from '../collector-poll-sender';
import {
  GITHUB_APP_OPTIONS,
  type GitHubAppOptions,
} from '../github-app-options';
import { signGitHubDelivery } from '../github-signature';

export const GITHUB_TEST_KEY = randomBytes(32).toString('base64');
export const testCipher = (): SecretCipher =>
  SecretCipher.fromKeyText(GITHUB_TEST_KEY);

export const APP_PEM = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ type: 'pkcs1', format: 'pem' })
  .toString();
export const WEBHOOK_SECRET = 'whsec-0123456789abcdef-github';
export const CLIENT_SECRET = 'client-secret-abcdef0123456789';
export const MANIFEST_CODE = 'code-from-github-0123';
export const APP_ID = 4242;
export const SLUG = 'agentdock-dock-example';

/** One installation of the fake GitHub, with the repos it lists. */
export interface FakeInstallation {
  id: number;
  login: string;
  suspended?: boolean;
  repos: { id: number; fullName: string }[];
}

/**
 * The GitHub REST endpoints the App module reads (D1, D4, D11), in memory.
 * Every request is recorded, so a test can say what was — and was not — asked.
 */
export class FakeGitHub {
  installations: FakeInstallation[] = [];
  hookDeliveryStatus: number | null = 200;
  calls: { method: string; path: string; authorization: string | null }[] = [];

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers);
    this.calls.push({
      method,
      path: url.pathname,
      authorization: headers.get('authorization'),
    });
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    const path = url.pathname;
    const page = Number(url.searchParams.get('page') ?? '1');
    const bearer = headers.get('authorization')?.startsWith('Bearer ') ?? false;

    if (
      method === 'POST' &&
      path === `/app-manifests/${MANIFEST_CODE}/conversions`
    )
      return json(
        {
          id: APP_ID,
          slug: SLUG,
          owner: { login: 'AndreyBegma' },
          pem: APP_PEM,
          webhook_secret: WEBHOOK_SECRET,
          client_id: 'Iv1.abc',
          client_secret: CLIENT_SECRET,
        },
        201,
      );
    if (method === 'POST' && path.startsWith('/app-manifests/'))
      return json({ message: 'Not Found' }, 404);
    if (!bearer && !path.startsWith('/installation/'))
      return json({ message: 'Requires authentication' }, 401);
    if (method === 'GET' && path === '/app')
      return json({ id: APP_ID, slug: SLUG, owner: { login: 'AndreyBegma' } });
    if (method === 'GET' && path === '/app/installations')
      return json(
        page > 1
          ? []
          : this.installations.map((i) => ({
              id: i.id,
              account: { login: i.login, type: 'User' },
              suspended_at: i.suspended ? '2026-10-01T00:00:00Z' : null,
            })),
      );
    const token = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(path);
    if (method === 'POST' && token)
      return json({ token: `ghs_${token[1]}` }, 201);
    if (method === 'GET' && path === '/installation/repositories') {
      const id = Number(
        headers.get('authorization')?.replace('token ghs_', ''),
      );
      const found = this.installations.find((i) => i.id === id);
      const repos = page > 1 ? [] : (found?.repos ?? []);
      return json({
        total_count: repos.length,
        repositories: repos.map((r) => ({ id: r.id, full_name: r.fullName })),
      });
    }
    if (method === 'GET' && path === '/app/hook/deliveries')
      return json(
        this.hookDeliveryStatus === null
          ? []
          : [{ id: 1, status_code: this.hookDeliveryStatus }],
      );
    return json({ message: 'Not Found' }, 404);
  };
}

/** Records every `collector.poll` instead of sending it. */
export class RecordingPollSender extends CollectorPollSender {
  sent: { at: number; runnerId: string; args: CollectorPollArgs }[] = [];
  /** Delay before answering, to stand in for a slow or offline runner. */
  delayMs = 0;
  outcome: CollectorPollOutcome = 'sent';

  override async send(
    runnerId: string,
    args: CollectorPollArgs,
  ): Promise<CollectorPollOutcome> {
    this.sent.push({ at: Date.now(), runnerId, args });
    if (this.delayMs > 0)
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    return this.outcome;
  }
}

export interface GitHubE2e extends E2eContext {
  github: FakeGitHub;
  sender: RecordingPollSender;
  options: GitHubAppOptions;
}

export const testOptions = (
  github: FakeGitHub,
  over: Partial<GitHubAppOptions> = {},
): GitHubAppOptions => ({
  publicUrl: 'https://dock.example',
  appUrl: 'http://web.test',
  apiBase: 'http://github.test',
  debounceMs: 300,
  healthIntervalMs: 60_000,
  autoStart: false,
  requestTimeoutMs: 2_000,
  fetch: github.fetch,
  ...over,
});

/** The API with a known encryption key, a fake GitHub and a recording poll sender. */
export const createGitHubApp = async (
  over: Partial<GitHubAppOptions> = {},
  cipher: SecretCipher = testCipher(),
): Promise<GitHubE2e> => {
  const github = new FakeGitHub();
  const sender = new RecordingPollSender();
  const options = testOptions(github, over);
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(SecretCipher)
    .useValue(cipher)
    .overrideProvider(GITHUB_APP_OPTIONS)
    .useValue(options)
    .overrideProvider(CollectorPollSender)
    .useValue(sender)
    .compile();
  const app = moduleRef.createNestApplication<INestApplication<App>>();
  configureApp(app);
  await app.init();
  return {
    app,
    prisma: app.get(PrismaService),
    http: () => request(app.getHttpServer()),
    github,
    sender,
    options,
  };
};

export const resetGitHub = (prisma: PrismaService) =>
  prisma.$executeRawUnsafe(
    'TRUNCATE TABLE user_sessions, settings, users, runners, projects, github_app, github_installations, github_deliveries CASCADE',
  );

/** A signed delivery as GitHub sends it. */
export const deliver = (
  ctx: E2eContext,
  event: string,
  payload: object,
  options: {
    deliveryId?: string;
    secret?: string;
    signature?: string | null;
  } = {},
) => {
  const body = JSON.stringify(payload);
  const req = ctx
    .http()
    .post('/hooks/github')
    .set('Content-Type', 'application/json')
    .set('X-GitHub-Event', event)
    .set('X-GitHub-Delivery', options.deliveryId ?? randomUUID());
  const signature =
    options.signature === undefined
      ? signGitHubDelivery(options.secret ?? WEBHOOK_SECRET, body)
      : options.signature;
  if (signature !== null) req.set('X-Hub-Signature-256', signature);
  return req.send(body);
};

/** A project on `repo`, on a fresh runner unless one is given. */
export const seedRepoProject = async (
  prisma: PrismaService,
  repo: string,
  root: string,
  options: { runnerId?: string; baseBranch?: string } = {},
): Promise<{ runnerId: string; projectId: string }> => {
  const runnerId =
    options.runnerId ??
    (await prisma.runner.create({ data: { name: `desk-${root}` } })).id;
  const project = await prisma.project.create({
    data: {
      runnerId,
      rootPath: root,
      repo,
      displayName: root.slice(root.lastIndexOf('/') + 1),
      baseBranch: options.baseBranch ?? 'develop',
      baseSource: 'config',
      hasClaudeMd: true,
      hasAgentsMd: false,
      lastInspectedAt: new Date('2026-10-01T00:00:00Z'),
    },
  });
  return { runnerId, projectId: project.id };
};

/** Waits until `check` holds, or fails after `ms`. */
export const eventually = async (
  check: () => boolean | Promise<boolean>,
  ms = 5_000,
): Promise<void> => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`condition not met within ${ms} ms`);
};

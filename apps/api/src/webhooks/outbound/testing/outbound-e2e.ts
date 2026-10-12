import { randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { WebhookDeliveryView, WebhookWithSecret } from '@agentdock/shared';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../../../app.module';
import { SecretCipher } from '../../../common/crypto';
import { configureApp } from '../../../configure-app';
import { PrismaService } from '../../../database/prisma.service';
import {
  createUser,
  type E2eContext,
  login,
  type Session,
} from '../../../test/e2e-app';
import {
  type HostResolver,
  type ResolvedAddress,
  WEBHOOKS_OPTIONS,
  type WebhooksOptions,
} from '../../common';
import { WebhookDeliveryWorker } from '../webhook-delivery-worker';
import { WebhookDispatcher } from '../webhook-dispatcher';
import { WebhookRetentionJob } from '../webhook-retention.job';

export const OUTBOUND_TEST_KEY = randomBytes(32).toString('base64');

/** A DNS the test controls: names map to addresses, anything else fails. */
export class FakeDns {
  private readonly names = new Map<string, ResolvedAddress[]>();

  set(host: string, ...addresses: string[]): void {
    this.names.set(
      host,
      addresses.map((address) => ({
        address,
        family: address.includes(':') ? 6 : 4,
      })),
    );
  }

  readonly resolve: HostResolver = async (host) => {
    const found = this.names.get(host);
    if (!found) throw new Error(`ENOTFOUND ${host}`);
    return found;
  };
}

export interface ReceivedRequest {
  path: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** A webhook receiver on 127.0.0.1 that answers what a test scripts. */
export class Receiver {
  readonly requests: ReceivedRequest[] = [];
  status = 200;
  /** `Location` sent with a 3xx. */
  location = 'http://127.0.0.1:1/elsewhere';

  private constructor(private readonly server: http.Server) {}

  static async start(): Promise<Receiver> {
    const server = http.createServer();
    const receiver = new Receiver(server);
    server.on('request', (req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        receiver.requests.push({
          path: req.url ?? '',
          headers: req.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
        const headers: http.OutgoingHttpHeaders =
          receiver.status >= 300 && receiver.status < 400
            ? { Location: receiver.location }
            : {};
        res.writeHead(receiver.status, headers);
        res.end(receiver.status >= 400 ? 'receiver error' : 'ok');
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    return receiver;
  }

  get port(): number {
    return (this.server.address() as AddressInfo).port;
  }

  /** `http://<host>:<port>/hook` — `host` must resolve to 127.0.0.1. */
  url(host = 'n8n.lan'): string {
    return `http://${host}:${this.port}/hook`;
  }

  reset(): void {
    this.requests.length = 0;
    this.status = 200;
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}

export interface OutboundE2e extends E2eContext {
  dns: FakeDns;
  options: WebhooksOptions;
  dispatcher: WebhookDispatcher;
  worker: WebhookDeliveryWorker;
  retention: WebhookRetentionJob;
}

/**
 * The app with the webhook loops off (tests call `tick()`), host resolution
 * through `FakeDns`, a short request timeout, and `cipher` as the
 * `SecretCipher` (default: `OUTBOUND_TEST_KEY`).
 */
export const createOutboundApp = async (
  cipher = SecretCipher.fromKeyText(OUTBOUND_TEST_KEY),
): Promise<OutboundE2e> => {
  const dns = new FakeDns();
  const options: WebhooksOptions = {
    workerEnabled: false,
    requestTimeoutMs: 2_000,
    resolve: dns.resolve,
  };
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(SecretCipher)
    .useValue(cipher)
    .overrideProvider(WEBHOOKS_OPTIONS)
    .useValue(options)
    .compile();
  const app = moduleRef.createNestApplication<INestApplication<App>>();
  configureApp(app);
  await app.init();
  return {
    app,
    prisma: app.get(PrismaService),
    http: () => request(app.getHttpServer()),
    dns,
    options,
    dispatcher: app.get(WebhookDispatcher),
    worker: app.get(WebhookDeliveryWorker),
    retention: app.get(WebhookRetentionJob),
  };
};

export const resetOutbound = (prisma: PrismaService) =>
  prisma.$executeRawUnsafe(
    'TRUNCATE TABLE user_sessions, settings, users, runners, projects, webhooks, webhook_dispatcher_state, inbound_triggers CASCADE',
  );

export const WEBHOOKS_ROUTE = '/admin/webhooks';
export const WEBHOOK_SETTINGS_ROUTE = '/admin/settings/webhooks';

/** What every outbound suite works with, fresh for each test. */
export interface OutboundFixture {
  ctx: OutboundE2e;
  receiver: Receiver;
  admin: Session;
  adminId: string;
}

/**
 * Registers a suite's hooks: one app and one receiver for the file; before
 * each test the tables are emptied, `n8n.lan` resolves to the receiver,
 * `hooks.example.com` to a public address, and an admin is signed in.
 * Returns the current fixture.
 */
export const useOutboundFixture = (): (() => OutboundFixture) => {
  let ctx: OutboundE2e;
  let receiver: Receiver;
  let current: OutboundFixture;
  beforeAll(async () => {
    ctx = await createOutboundApp();
    receiver = await Receiver.start();
  });
  afterAll(async () => {
    await ctx.app.close();
    await receiver.close();
  });
  beforeEach(async () => {
    await resetOutbound(ctx.prisma);
    receiver.reset();
    ctx.dns.set('n8n.lan', '127.0.0.1');
    ctx.dns.set('hooks.example.com', '93.184.216.34');
    const adminId = (await createUser(ctx.prisma, 'ada@example.com', 'admin'))
      .id;
    current = {
      ctx,
      receiver,
      admin: await login(ctx, 'ada@example.com'),
      adminId,
    };
  });
  return () => current;
};

/** `n8n.lan` on the private-target allowlist (D15). */
export const allowN8n = async (admin: Session): Promise<void> => {
  const response = await admin.send('put', WEBHOOK_SETTINGS_ROUTE, {
    allowedPrivateTargets: ['n8n.lan'],
  });
  expect(response.status).toBe(200);
};

export const createHook = async (
  { admin, receiver }: OutboundFixture,
  body: Partial<{
    name: string;
    url: string;
    events: string[];
    projectIds: string[];
  }> = {},
): Promise<WebhookWithSecret> => {
  const response = await admin.send('post', WEBHOOKS_ROUTE, {
    name: 'n8n',
    url: receiver.url(),
    events: ['webhook.test', 'slot.checkpoint'],
    projectIds: [],
    ...body,
  });
  expect(response.status).toBe(201);
  return response.body as WebhookWithSecret;
};

export const sendTest = async (
  admin: Session,
  id: string,
): Promise<WebhookDeliveryView> => {
  const response = await admin.send('post', `${WEBHOOKS_ROUTE}/${id}/test`);
  expect(response.status).toBe(202);
  return response.body as WebhookDeliveryView;
};

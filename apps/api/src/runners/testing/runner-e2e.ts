import type { PairingCodeResponse } from '@agentdock/shared';
import {
  type Capabilities,
  type HelloMessage,
  PROTOCOL_VERSION,
  RUNNER_SOCKET_PATH,
  type RunnerMessage,
  type ServerMessage,
  serverMessageSchema,
} from '@agentdock/shared/protocol';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { WebSocket } from 'ws';
import { AppModule } from '../../app.module';
import { configureApp } from '../../configure-app';
import { PrismaService } from '../../database/prisma.service';
import {
  createUser,
  type E2eContext,
  login,
  nextIp,
  type Session,
} from '../../test/e2e-app';
import {
  defaultRunnerOptions,
  RUNNER_OPTIONS,
  type RunnerOptions,
} from '../runner-options';

export interface RunnerE2eContext extends E2eContext {
  /** `http://127.0.0.1:<port>` — the API origin the runner pairs with. */
  origin: string;
}

/** The app, listening on an ephemeral port, with the runner timings overridden. */
export const createRunnerE2eApp = async (
  options: Partial<RunnerOptions> = {},
): Promise<RunnerE2eContext> => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(RUNNER_OPTIONS)
    .useValue({ ...defaultRunnerOptions, ...options })
    .compile();
  const app = moduleRef.createNestApplication<INestApplication<App>>();
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  const origin = (await app.getUrl()).replace(/\/+$/, '');
  process.env.API_URL = origin;
  return {
    app,
    prisma: app.get(PrismaService),
    http: () => request(app.getHttpServer()),
    origin,
  };
};

export const adminSession = async (ctx: E2eContext): Promise<Session> => {
  await createUser(ctx.prisma, 'admin@example.com', 'admin');
  return login(ctx, 'admin@example.com');
};

export const createRunner = async (
  admin: Session,
  name = 'desk',
): Promise<PairingCodeResponse> => {
  const response = await admin.send('post', '/admin/runners', { name });
  if (response.status !== 201) {
    throw new Error(`create runner → ${response.status} ${response.text}`);
  }
  return response.body as PairingCodeResponse;
};

export const pairBody = (code: string) => ({
  code,
  hostname: 'test-host',
  version: '0.1.0',
  protocolVersion: PROTOCOL_VERSION,
});

/** Creates and pairs a runner over HTTP; returns its id and token. */
export const pairedRunner = async (
  ctx: E2eContext,
  admin: Session,
  name?: string,
): Promise<{ runnerId: string; token: string }> => {
  const { pairingCode } = await createRunner(admin, name);
  const response = await ctx
    .http()
    .post('/runners/pair')
    .set('X-Forwarded-For', nextIp())
    .send(pairBody(pairingCode));
  if (response.status !== 200) {
    throw new Error(`pair → ${response.status} ${response.text}`);
  }
  return response.body as { runnerId: string; token: string };
};

export const capabilities: Capabilities = {
  tmux: '3.5a',
  git: '2.55.0',
  gh: null,
  runtimes: { claude: { version: '2.3.1' }, codex: null },
  profiles: [
    {
      id: 'claude-main',
      runtime: 'claude',
      env: { CLAUDE_CONFIG_DIR: '~/.claude-profiles/main' },
      args: [],
      authenticated: true,
    },
  ],
  codeSentinel: null,
  otlp: null,
};

export const hello = (overrides: Partial<HelloMessage> = {}): HelloMessage => ({
  type: 'hello',
  runnerVersion: '0.1.0',
  protocolVersion: PROTOCOL_VERSION,
  hostname: 'test-host',
  os: 'linux',
  arch: 'x64',
  capabilities,
  lastAckedSeq: 0,
  ...overrides,
});

export interface Closed {
  code: number;
  reason: string;
}

/** A raw protocol client: what the #5 runner speaks, driven frame by frame. */
export class TestRunnerSocket {
  readonly closed: Promise<Closed>;
  private readonly inbox: ServerMessage[] = [];
  private waiters: (() => void)[] = [];
  readonly socket: WebSocket;

  constructor(origin: string, token: string | null) {
    const url = `${origin.replace(/^http/, 'ws')}${RUNNER_SOCKET_PATH}`;
    this.socket = new WebSocket(
      url,
      token ? { headers: { Authorization: `Bearer ${token}` } } : {},
    );
    this.socket.on('message', (data) => {
      this.inbox.push(serverMessageSchema.parse(JSON.parse(data.toString())));
      this.wake();
    });
    this.closed = new Promise((resolve) => {
      this.socket.on('close', (code, reason) => {
        resolve({ code, reason: reason.toString() });
        this.wake();
      });
    });
    this.socket.on('error', () => {});
  }

  opened(): Promise<void> {
    if (this.socket.readyState === WebSocket.OPEN) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.socket.once('open', () => resolve());
      this.socket.once('close', () => reject(new Error('closed before open')));
    });
  }

  send(message: RunnerMessage | Record<string, unknown>): void {
    this.socket.send(JSON.stringify(message));
  }

  /** The next server message of `type`, skipping others; fails after `ms`. */
  async next<T extends ServerMessage['type']>(
    type: T,
    ms = 5_000,
  ): Promise<Extract<ServerMessage, { type: T }>> {
    const deadline = Date.now() + ms;
    for (;;) {
      const index = this.inbox.findIndex((m) => m.type === type);
      if (index >= 0) {
        return this.inbox.splice(index, 1)[0] as Extract<
          ServerMessage,
          { type: T }
        >;
      }
      if (this.socket.readyState === WebSocket.CLOSED) {
        throw new Error(`socket closed while waiting for ${type}`);
      }
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`no ${type} within ${ms} ms`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  /** Opens, sends `hello`, and waits for `welcome`. */
  async connect(message: HelloMessage = hello()) {
    await this.opened();
    this.send(message);
    return this.next('welcome');
  }

  close(): Promise<Closed> {
    this.socket.close(1000, 'test done');
    return this.closed;
  }

  private wake(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w();
  }
}

/** Polls `check` until it returns a value, or fails after `ms`. */
export const eventually = async <T>(
  what: string,
  check: () => Promise<T | undefined>,
  ms = 10_000,
  every = 100,
): Promise<T> => {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, every));
  }
};

import {
  LIVE_SOCKET_PATH,
  type LiveClientMessage,
  type LiveServerMessage,
  liveServerMessageSchema,
  SESSION_COOKIE,
} from '@agentdock/shared';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { WebSocket } from 'ws';
import { AppModule } from '../../app.module';
import { configureApp } from '../../configure-app';
import { PrismaService } from '../../database/prisma.service';
import type { E2eContext } from '../../test/e2e-app';
import {
  defaultLiveOptions,
  LIVE_OPTIONS,
  type LiveOptions,
} from '../live-options';

export interface LiveE2eContext extends E2eContext {
  /** `ws://127.0.0.1:<port>/live`. */
  liveUrl: string;
}

/** The app, listening on an ephemeral port, with the live timings overridden. */
export const createLiveE2eApp = async (
  options: Partial<LiveOptions> = {},
): Promise<LiveE2eContext> => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(LIVE_OPTIONS)
    .useValue({ ...defaultLiveOptions, ...options })
    .compile();
  const app = moduleRef.createNestApplication<INestApplication<App>>();
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  const origin = (await app.getUrl()).replace(/\/+$/, '');
  return {
    app,
    prisma: app.get(PrismaService),
    http: () => request(app.getHttpServer()),
    liveUrl: `${origin.replace(/^http/, 'ws')}${LIVE_SOCKET_PATH}`,
  };
};

export interface Closed {
  code: number;
  reason: string;
}

/** A browser-like `/live` client: a session cookie and an `Origin` header. */
export class TestLiveSocket {
  readonly closed: Promise<Closed>;
  readonly socket: WebSocket;
  private readonly inbox: LiveServerMessage[] = [];
  private waiters: (() => void)[] = [];

  constructor(
    url: string,
    {
      token,
      origin,
      autoPong = true,
    }: { token?: string; origin?: string; autoPong?: boolean },
  ) {
    const headers: Record<string, string> = {};
    if (token) headers.Cookie = `${SESSION_COOKIE}=${token}`;
    if (origin) headers.Origin = origin;
    this.socket = new WebSocket(url, { headers, autoPong });
    this.socket.on('message', (data) => {
      this.inbox.push(
        liveServerMessageSchema.parse(JSON.parse(data.toString())),
      );
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

  send(message: LiveClientMessage | Record<string, unknown>): void {
    this.socket.send(JSON.stringify(message));
  }

  sendRaw(frame: string): void {
    this.socket.send(frame);
  }

  /** Opens and round-trips a `ping`: the socket is authenticated and registered. */
  async ready(): Promise<this> {
    await this.opened();
    this.send({ type: 'ping' });
    await this.next('pong');
    return this;
  }

  /** The next message of `type`, skipping others; fails after `ms`. */
  async next<T extends LiveServerMessage['type']>(
    type: T,
    ms = 5_000,
  ): Promise<Extract<LiveServerMessage, { type: T }>> {
    const deadline = Date.now() + ms;
    for (;;) {
      const index = this.inbox.findIndex((m) => m.type === type);
      if (index >= 0) {
        return this.inbox.splice(index, 1)[0] as Extract<
          LiveServerMessage,
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

  /** Subscribes and returns the reply: `subscribed` or `error`. */
  async subscribe(topic: string): Promise<LiveServerMessage> {
    this.send({ type: 'subscribe', topic });
    const deadline = Date.now() + 5_000;
    for (;;) {
      const index = this.inbox.findIndex(
        (m) =>
          (m.type === 'subscribed' || m.type === 'error') && m.topic === topic,
      );
      if (index >= 0) return this.inbox.splice(index, 1)[0];
      if (Date.now() > deadline) throw new Error(`no reply for ${topic}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  private wake(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w();
  }
}

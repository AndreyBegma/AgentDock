import { CSRF_COOKIE, type Role, SESSION_COOKIE } from '@agentdock/shared';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { UserStatus } from '@prisma/client';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../app.module';
import { hashPassword } from '../auth/password';
import { configureApp } from '../configure-app';
import { PrismaService } from '../database/prisma.service';

export const PASSWORD = 'correct horse battery staple';

let ipCounter = 0;
/** A fresh client address, so the per-IP login throttle never couples tests. */
export const nextIp = (): string => {
  ipCounter += 1;
  return `10.${(ipCounter >> 16) & 255}.${(ipCounter >> 8) & 255}.${ipCounter & 255}`;
};

export interface E2eContext {
  app: INestApplication<App>;
  prisma: PrismaService;
  http: () => ReturnType<typeof request>;
}

export const createE2eApp = async (): Promise<E2eContext> => {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  const app = moduleRef.createNestApplication<INestApplication<App>>();
  configureApp(app);
  await app.init();
  return {
    app,
    prisma: app.get(PrismaService),
    http: () => request(app.getHttpServer()),
  };
};

export const resetDatabase = (prisma: PrismaService) =>
  prisma.$executeRawUnsafe(
    'TRUNCATE TABLE user_sessions, settings, users CASCADE',
  );

export const createUser = async (
  prisma: PrismaService,
  email: string,
  role: Role,
  status: UserStatus = 'active',
) =>
  prisma.user.create({
    data: {
      email,
      role,
      status,
      passwordHash: await hashPassword(PASSWORD),
    },
  });

const cookieValue = (setCookie: string[], name: string): string | undefined =>
  setCookie
    .find((c) => c.startsWith(`${name}=`))
    ?.split(';')[0]
    .slice(name.length + 1);

export const setCookies = (response: request.Response): string[] => {
  const header = response.headers['set-cookie'] as unknown;
  if (Array.isArray(header)) return header as string[];
  return typeof header === 'string' ? [header] : [];
};

/** A signed-in caller: carries the session cookie and echoes the CSRF token. */
export class Session {
  constructor(
    private readonly ctx: E2eContext,
    readonly token: string,
    readonly csrf: string,
  ) {}

  private cookie(): string {
    return `${SESSION_COOKIE}=${this.token}; ${CSRF_COOKIE}=${this.csrf}`;
  }

  get(path: string) {
    return this.ctx.http().get(path).set('Cookie', this.cookie());
  }

  send(
    method: 'post' | 'patch' | 'put' | 'delete',
    path: string,
    body?: object,
  ) {
    const req = this.ctx
      .http()
      [method](path)
      .set('Cookie', this.cookie())
      .set('X-CSRF-Token', this.csrf);
    return body ? req.send(body) : req;
  }

  /** The same request without a CSRF header. */
  sendWithoutCsrf(method: 'post' | 'patch' | 'put' | 'delete', path: string) {
    return this.ctx.http()[method](path).set('Cookie', this.cookie());
  }
}

export const login = async (
  ctx: E2eContext,
  email: string,
  password = PASSWORD,
): Promise<Session> => {
  const response = await ctx
    .http()
    .post('/auth/login')
    .set('X-Forwarded-For', nextIp())
    .send({ email, password });
  if (response.status !== 200) {
    throw new Error(`login ${email} → ${response.status} ${response.text}`);
  }
  const cookies = setCookies(response);
  const token = cookieValue(cookies, SESSION_COOKIE);
  const csrf = cookieValue(cookies, CSRF_COOKIE);
  if (!token || !csrf) throw new Error('login set no session cookies');
  return new Session(ctx, token, csrf);
};

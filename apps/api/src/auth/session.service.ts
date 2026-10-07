import type { SessionInfo } from '@agentdock/shared';
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import type { AuthContext } from './auth-request';
import { generateToken, hashToken } from './tokens';
import { toPublicUser } from './user-mapper';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
export const SESSION_IDLE_MS = 7 * DAY;
export const SESSION_ABSOLUTE_MS = 30 * DAY;
const LAST_SEEN_REFRESH_MS = MINUTE;

export interface IssuedSession {
  token: string;
  csrfToken: string;
  sessionId: string;
}

/**
 * The CSRF token is derived from the session token, so a cookie planted by a
 * sibling subdomain cannot be paired with a forged header: only a page that
 * can read `ad_csrf` — same origin — can echo the right value.
 */
export const csrfTokenFor = (sessionToken: string): string =>
  Buffer.from(hashToken(`csrf:${sessionToken}`), 'hex').toString('base64url');

@Injectable()
export class SessionService {
  constructor(private readonly prisma: PrismaService) {}

  async create(
    userId: string,
    meta: { ip?: string; userAgent?: string },
  ): Promise<IssuedSession> {
    const token = generateToken();
    const now = Date.now();
    const session = await this.prisma.userSession.create({
      data: {
        userId,
        tokenHash: hashToken(token),
        expiresAt: new Date(now + SESSION_ABSOLUTE_MS),
        ip: meta.ip ?? null,
        userAgent: meta.userAgent?.slice(0, 512) ?? null,
      },
    });
    return { token, csrfToken: csrfTokenFor(token), sessionId: session.id };
  }

  /** The session behind a cookie token, or null if it is unknown, expired or its user is not active. */
  async resolve(token: string): Promise<AuthContext | null> {
    const session = await this.prisma.userSession.findUnique({
      where: { tokenHash: hashToken(token) },
      include: { user: true },
    });
    if (!session) return null;

    const now = Date.now();
    const expired =
      session.expiresAt.getTime() <= now ||
      session.lastSeenAt.getTime() + SESSION_IDLE_MS <= now;
    if (expired || session.user.status !== 'active') {
      await this.prisma.userSession.deleteMany({ where: { id: session.id } });
      return null;
    }

    if (now - session.lastSeenAt.getTime() >= LAST_SEEN_REFRESH_MS) {
      await this.prisma.userSession.update({
        where: { id: session.id },
        data: { lastSeenAt: new Date(now) },
      });
    }
    return { user: toPublicUser(session.user), sessionId: session.id };
  }

  async list(userId: string, currentId: string): Promise<SessionInfo[]> {
    const sessions = await this.prisma.userSession.findMany({
      where: { userId },
      orderBy: { lastSeenAt: 'desc' },
    });
    return sessions.map((s) => ({
      id: s.id,
      createdAt: s.createdAt.toISOString(),
      lastSeenAt: s.lastSeenAt.toISOString(),
      expiresAt: s.expiresAt.toISOString(),
      ip: s.ip,
      userAgent: s.userAgent,
      current: s.id === currentId,
    }));
  }

  /** Revokes one of the user's own sessions. False when no such session belongs to them. */
  async revokeOwn(userId: string, sessionId: string): Promise<boolean> {
    const { count } = await this.prisma.userSession.deleteMany({
      where: { id: sessionId, userId },
    });
    return count > 0;
  }

  async revokeAll(userId: string, exceptSessionId?: string): Promise<void> {
    await this.prisma.userSession.deleteMany({
      where: {
        userId,
        ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}),
      },
    });
  }
}

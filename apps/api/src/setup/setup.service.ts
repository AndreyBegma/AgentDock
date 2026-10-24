import { AUTH_ERROR, type PublicUser } from '@nautelle/shared';
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import {
  type RequestOrigin,
  SYSTEM_ACTOR,
  userActor,
} from '../audit/audit.types';
import { authError } from '../auth/auth-error';
import { type IssuedSession, SessionService } from '../auth/session.service';
import {
  CreateAdminError,
  type CreateAdminInput,
  createAdmin,
} from '../cli/create-admin';
import { PrismaService } from '../database/prisma.service';
import type { SetupAdminDto } from './dto';
import { SetupToken } from './setup-token';

const DEFAULT_WEB_URL = 'http://localhost:3517';

export const webUrl = (env: NodeJS.ProcessEnv): string =>
  (env.WEB_URL || DEFAULT_WEB_URL).replace(/\/+$/, '');

const setupDone = () =>
  authError(409, AUTH_ERROR.setupDone, 'This server is already set up');

/**
 * C-367: the first-run setup. While no user exists the API holds a one-time
 * token, logged on boot as the setup link; `POST /setup/admin` with it creates
 * the first admin and signs them in. `ADMIN_EMAIL` / `ADMIN_PASSWORD` create
 * that admin at boot instead, for a headless install.
 */
@Injectable()
export class SetupService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SetupService.name);
  private readonly token = new SetupToken();

  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
  ) {}

  // Tests drive `prepare` themselves: a boot must not create an admin from a
  // developer's `.env` or print a link into the test output.
  async onApplicationBootstrap(): Promise<void> {
    if (process.env.APP_ENV === 'test') return;
    await this.prepare(process.env);
  }

  /** On boot: create the admin from the environment, or log the setup link. */
  async prepare(env: NodeJS.ProcessEnv): Promise<void> {
    if (!(await this.needsSetup())) return;
    if (env.ADMIN_EMAIL && env.ADMIN_PASSWORD) {
      try {
        const admin = await this.createIfNone({
          email: env.ADMIN_EMAIL,
          password: env.ADMIN_PASSWORD,
          name: env.ADMIN_NAME,
        });
        if (admin) {
          await this.recordCreated(admin, 'env');
          this.logger.log(`Admin ${admin.email} created from ADMIN_EMAIL`);
          return;
        }
      } catch (error) {
        if (!(error instanceof CreateAdminError)) throw error;
        this.logger.error(`ADMIN_EMAIL / ADMIN_PASSWORD: ${error.message}`);
      }
    }
    if (!(await this.needsSetup())) return;
    this.logger.warn(
      `No user yet. Open ${webUrl(env)}/setup?token=${this.issueToken()} to create the first admin.`,
    );
  }

  async needsSetup(): Promise<boolean> {
    return (await this.prisma.user.count()) === 0;
  }

  /** A new setup token; the one issued before stops working. */
  issueToken(): string {
    return this.token.issue();
  }

  async createFirstAdmin(
    dto: SetupAdminDto,
    origin: RequestOrigin,
  ): Promise<{ user: PublicUser; session: IssuedSession }> {
    // Done first: once set up, the answer is the same with or without a token.
    if (!(await this.needsSetup())) throw setupDone();
    if (!this.token.matches(dto.token)) {
      throw authError(
        403,
        AUTH_ERROR.setupTokenInvalid,
        'The setup link is missing its token or the token is wrong; use the link from the API log',
      );
    }

    let user: PublicUser | null;
    try {
      user = await this.createIfNone(dto);
    } catch (error) {
      if (!(error instanceof CreateAdminError)) throw error;
      throw authError(400, AUTH_ERROR.setupInvalid, error.message);
    }
    if (!user) throw setupDone();
    this.token.spend();

    await this.recordCreated(user, 'setup', origin);
    const session = await this.sessions.create(user.id, origin);
    await this.audit.record({
      actor: userActor(user.id),
      origin,
      action: 'auth.login',
      target: { type: 'user', id: user.id },
      result: 'ok',
      meta: { sessionId: session.sessionId, via: 'setup' },
    });
    return { user, session };
  }

  /**
   * The admin, or null when a user already exists. The check and the insert
   * share one transaction under an advisory lock, so of two concurrent calls
   * only one creates a user.
   */
  private createIfNone(input: CreateAdminInput): Promise<PublicUser | null> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('nautelle.first-admin'))`;
      if ((await tx.user.count()) > 0) return null;
      return createAdmin(tx, input);
    });
  }

  private recordCreated(
    admin: PublicUser,
    via: 'env' | 'setup',
    origin?: RequestOrigin,
  ): Promise<void> {
    return this.audit.record({
      actor: via === 'setup' ? userActor(admin.id) : SYSTEM_ACTOR,
      origin,
      action: 'user.create',
      target: { type: 'user', id: admin.id },
      after: { email: admin.email, role: admin.role, status: admin.status },
      result: 'ok',
      meta: { via },
    });
  }
}

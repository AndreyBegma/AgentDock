import { type AdminUser, AUTH_ERROR, type Role } from '@agentdock/shared';
import { BadRequestException, Injectable } from '@nestjs/common';
import type { Prisma, User, UserStatus } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { type AuditContext, SYSTEM_ACTOR } from '../audit/audit.types';
import { authError } from '../auth/auth-error';
import { toAdminUser } from '../auth/user-mapper';
import { PrismaService } from '../database/prisma.service';
import type { UpdateUserDto } from './dto';

type Tx = Prisma.TransactionClient;

const notFound = () => authError(404, AUTH_ERROR.notFound, 'User not found');
const invalidTransition = (from: UserStatus) =>
  authError(
    409,
    AUTH_ERROR.invalidTransition,
    `Not allowed for a ${from} account`,
  );

@Injectable()
export class AdminUsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(status?: UserStatus): Promise<AdminUser[]> {
    const users = await this.prisma.user.findMany({
      where: status ? { status } : {},
      orderBy: { createdAt: 'asc' },
    });
    return users.map(toAdminUser);
  }

  /** Approval sets the status and the role in one action (spec D4). */
  async approve(
    id: string,
    role: Role,
    adminId: string,
    ctx: AuditContext,
  ): Promise<AdminUser> {
    const [before, updated] = await this.prisma.$transaction(async (tx) => {
      const user = await this.lockUser(tx, id);
      if (user.status !== 'pending') throw invalidTransition(user.status);
      const changed = await tx.user.update({
        where: { id },
        data: {
          status: 'active',
          role,
          approvedById: adminId,
          approvedAt: new Date(),
        },
      });
      return [user, changed] as const;
    });
    await this.audit.record({
      ...ctx,
      action: 'user.approve',
      target: { type: 'user', id },
      before: { status: before.status, role: before.role },
      after: { status: updated.status, role: updated.role },
      result: 'ok',
    });
    return toAdminUser(updated);
  }

  async reject(id: string, ctx: AuditContext): Promise<AdminUser> {
    const [before, updated] = await this.prisma.$transaction(async (tx) => {
      const user = await this.lockUser(tx, id);
      if (user.status !== 'pending') throw invalidTransition(user.status);
      const changed = await tx.user.update({
        where: { id },
        data: { status: 'rejected' },
      });
      return [user, changed] as const;
    });
    await this.audit.record({
      ...ctx,
      action: 'user.reject',
      target: { type: 'user', id },
      before: { status: before.status },
      after: { status: updated.status },
      result: 'ok',
    });
    return toAdminUser(updated);
  }

  /**
   * Role and active/disabled changes for approved accounts. Disabling or
   * changing the role ends every session of that user (spec D11); the last
   * active admin cannot be demoted or disabled (spec D10).
   */
  async update(
    id: string,
    dto: UpdateUserDto,
    // A call from outside a request (a job, a script) acts as the system.
    ctx: AuditContext = { actor: SYSTEM_ACTOR },
  ): Promise<AdminUser> {
    if (dto.role === undefined && dto.status === undefined) {
      throw new BadRequestException('Nothing to update');
    }
    const [before, updated] = await this.prisma.$transaction(async (tx) => {
      await lockAdminSet(tx);
      const user = await this.lockUser(tx, id);
      if (user.status !== 'active' && user.status !== 'disabled') {
        throw invalidTransition(user.status);
      }
      const role = dto.role ?? user.role;
      const status = dto.status ?? user.status;
      const losesAdmin =
        isActiveAdmin(user) && !(role === 'admin' && status === 'active');
      if (losesAdmin) await this.assertNotLastAdmin(tx);

      const changed = await tx.user.update({
        where: { id },
        data: { role, status },
      });
      if (role !== user.role || status !== user.status) {
        await tx.userSession.deleteMany({ where: { userId: id } });
      }
      return [user, changed] as const;
    });
    // Only the fields that changed (spec "Retrofit").
    const fields = (['role', 'status'] as const).filter(
      (field) => before[field] !== updated[field],
    );
    await this.audit.record({
      ...ctx,
      action: 'user.update',
      target: { type: 'user', id },
      before: Object.fromEntries(fields.map((f) => [f, before[f]])),
      after: Object.fromEntries(fields.map((f) => [f, updated[f]])),
      result: 'ok',
    });
    return toAdminUser(updated);
  }

  async remove(id: string, ctx: AuditContext): Promise<void> {
    const removed = await this.prisma.$transaction(async (tx) => {
      await lockAdminSet(tx);
      const user = await this.lockUser(tx, id);
      if (isActiveAdmin(user)) await this.assertNotLastAdmin(tx);
      await tx.user.delete({ where: { id } });
      return user;
    });
    await this.audit.record({
      ...ctx,
      action: 'user.delete',
      target: { type: 'user', id },
      before: {
        email: removed.email,
        role: removed.role,
        status: removed.status,
      },
      result: 'ok',
    });
  }

  private async lockUser(tx: Tx, id: string): Promise<User> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM users WHERE id = ${id} FOR UPDATE`;
    if (rows.length === 0) throw notFound();
    return tx.user.findUniqueOrThrow({ where: { id } });
  }

  /** Only meaningful under `lockAdminSet`. */
  private async assertNotLastAdmin(tx: Tx): Promise<void> {
    const admins = await tx.user.count({
      where: { role: 'admin', status: 'active' },
    });
    if (admins <= 1) {
      throw authError(
        409,
        AUTH_ERROR.lastAdmin,
        'The last active admin cannot be demoted, disabled or deleted',
      );
    }
  }
}

/**
 * Serialises every change that can take away an active admin (spec D10). Row
 * locks alone deadlock when two admins demote each other — each holds its
 * target and waits for the other — so one transaction-scoped advisory lock
 * orders them instead: the second sees the first's result and gets 409.
 */
const lockAdminSet = (tx: Tx) =>
  tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('agentdock:admin-set'))`;

const isActiveAdmin = (user: User): boolean =>
  user.role === 'admin' && user.status === 'active';

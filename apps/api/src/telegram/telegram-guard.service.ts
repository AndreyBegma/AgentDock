import type { Role } from '@nautelle/shared';
import { roleAtLeast } from '@nautelle/shared/protocol';
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { ProjectAccessService } from '../projects';

/** #500: a read needs any active member; a write needs operator or higher. */
export type TelegramAccess = 'read' | 'write';

const MIN_ROLE: Record<TelegramAccess, Role> = {
  read: 'viewer',
  write: 'operator',
};

export type GuardRefusal =
  | 'not_linked'
  | 'inactive_user'
  | 'not_member'
  | 'role';

/** The linked user, as the services that act for them need it. */
export interface GuardUser {
  id: string;
  email: string;
  role: Role;
}

export type LinkedUser =
  | { ok: true; user: GuardUser }
  | {
      ok: false;
      reason: Extract<GuardRefusal, 'not_linked' | 'inactive_user'>;
      userId: string | null;
    };

export type MemberCheck =
  | { ok: true; user: GuardUser; role: Role }
  | {
      ok: false;
      reason: Exclude<GuardRefusal, 'not_linked'>;
      /** The role that fell short, on a `role` refusal. */
      role?: Role;
    };

export type GuardResult =
  | { ok: true; user: GuardUser; projectId: string; role: Role }
  | {
      ok: false;
      reason: GuardRefusal;
      userId: string | null;
      projectId: string;
      role?: Role;
    };

/**
 * #500: who a Telegram chat acts as, and what they may do on a project — the
 * check every button, reply and Board command runs from scratch: the chat's
 * link, an active user, `ProjectAccessService` (spec 10 D11) for membership,
 * and the role the action needs. Nothing is cached across updates.
 */
@Injectable()
export class TelegramGuard {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ProjectAccessService,
  ) {}

  /** The user `chatId` is linked to; null for an unlinked chat. */
  async linkedUserId(chatId: number): Promise<string | null> {
    const link = await this.prisma.telegramLink.findUnique({
      where: { chatId: BigInt(chatId) },
      select: { userId: true },
    });
    return link?.userId ?? null;
  }

  /** The chat's linked user, when they are active. */
  async linkedUser(chatId: number): Promise<LinkedUser> {
    const userId = await this.linkedUserId(chatId);
    if (!userId) return { ok: false, reason: 'not_linked', userId: null };
    const user = await this.activeUser(userId);
    return user
      ? { ok: true, user }
      : { ok: false, reason: 'inactive_user', userId };
  }

  /** Whether `userId` is active and may do `need` on `projectId`. */
  async member(
    userId: string,
    projectId: string,
    need: TelegramAccess,
  ): Promise<MemberCheck> {
    const user = await this.activeUser(userId);
    if (!user) return { ok: false, reason: 'inactive_user' };
    return this.memberOf(user, projectId, need);
  }

  /** The whole check for a chat: linked, active, member, role. */
  async authorize(
    chatId: number,
    projectId: string,
    need: TelegramAccess,
  ): Promise<GuardResult> {
    const linked = await this.linkedUser(chatId);
    if (!linked.ok) return { ...linked, projectId };
    const check = await this.memberOf(linked.user, projectId, need);
    return check.ok
      ? { ...check, projectId }
      : { ...check, userId: linked.user.id, projectId };
  }

  private async memberOf(
    user: GuardUser,
    projectId: string,
    need: TelegramAccess,
  ): Promise<MemberCheck> {
    const access = await this.access.resolve(user, projectId);
    if (!access) return { ok: false, reason: 'not_member' };
    if (!roleAtLeast(access.role, MIN_ROLE[need])) {
      return { ok: false, reason: 'role', role: access.role };
    }
    return { ok: true, user, role: access.role };
  }

  private async activeUser(userId: string): Promise<GuardUser | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, role: true, status: true },
    });
    return user?.status === 'active'
      ? { id: user.id, email: user.email, role: user.role }
      : null;
  }
}

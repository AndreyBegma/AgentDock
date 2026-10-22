import { projectRoleAtLeast } from '@nautelle/shared';
import { ForbiddenException, Injectable } from '@nestjs/common';
import type { AuditContext } from '../audit/audit.types';
import { systemActorFor } from '../audit/audit.types';
import { PrismaService } from '../database/prisma.service';
import { ProjectAccessService } from '../projects';
import { BOARD_SYSTEM_ACTOR, type BoardActor } from './board-work';

/**
 * C-181 (D-09, D-10): the person an automatic round runs as — whoever armed
 * Auto-run when ready, or started the round a `ci_fix` continues. Their
 * project role now decides the permission mode (bypass needs admin), their
 * user budget applies, and the round is audited as the system on their
 * behalf. Without a person the round runs as the board itself (operator,
 * project budgets only).
 */
@Injectable()
export class BoardPrincipals {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ProjectAccessService,
  ) {}

  /** The audit context of a round run for `userId`, before it is resolved. */
  ctxOf(userId: string | null): AuditContext {
    return userId === null
      ? BOARD_SYSTEM_ACTOR.ctx
      : { actor: systemActorFor(userId) };
  }

  /**
   * The actor for `userId` on the project; refused (403) when they are no
   * longer an active operator of it — a round never runs on lost authority.
   */
  async actor(projectId: string, userId: string | null): Promise<BoardActor> {
    if (userId === null) return BOARD_SYSTEM_ACTOR;
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, role: true, status: true },
    });
    const access =
      user?.status === 'active'
        ? await this.access.resolve(user, projectId)
        : null;
    if (!access || !projectRoleAtLeast(access.role, 'operator')) {
      throw new ForbiddenException(
        'The person this round runs as no longer runs cards on the project',
      );
    }
    return { userId, role: access.role, ctx: this.ctxOf(userId) };
  }
}

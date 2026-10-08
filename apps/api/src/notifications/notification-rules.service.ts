import {
  type ChannelSwitches,
  defaultChannels,
  isNotificationKind,
  kindAllowsChannel,
  kindsFor,
  NOTIFICATION_KIND_SPECS,
  type NotificationKind,
  type NotificationMuteView,
  type NotificationRulesUpdate,
  type NotificationRulesView,
  type Role,
} from '@agentdock/shared';
import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit';
import type { AuditContext } from '../audit/audit.types';
import type { AuthUser } from '../auth';
import { PrismaService } from '../database/prisma.service';
import { ProjectAccessService } from '../projects';
import { mutedProjectNotFound, notificationError } from './notification-error';

type Caller = Pick<AuthUser, 'id' | 'role'>;

/** A user's stored rules, by kind; a kind without a row uses the D1 default. */
export type StoredRules = Map<string, ChannelSwitches>;

/** The channels `kind` reaches for a user with `stored` rules and `role` there. */
export const channelsFor = (
  kind: NotificationKind,
  role: Role,
  stored: ChannelSwitches | undefined,
): ChannelSwitches => {
  const chosen = stored ?? defaultChannels(kind, role);
  return {
    inApp: chosen.inApp && kindAllowsChannel(kind, 'inApp'),
    telegram: chosen.telegram && kindAllowsChannel(kind, 'telegram'),
  };
};

/** Whether a mute with `until` silences at `at` (D3). */
export const muteActive = (until: Date | null, at: Date): boolean =>
  until === null || until.getTime() > at.getTime();

/**
 * Per-user rules and per-project mutes (spec 22 D3). A missing rule row is the
 * D1 default, so nothing is seeded; a user reads and changes only their own.
 */
@Injectable()
export class NotificationRulesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ProjectAccessService,
    private readonly audit: AuditService,
  ) {}

  async rules(user: Caller): Promise<NotificationRulesView> {
    const stored = await this.stored(user.id);
    return {
      rules: kindsFor(user.role).map((kind) => {
        const row = stored.get(kind);
        return {
          kind,
          ...channelsFor(kind, user.role, row),
          channels: [...NOTIFICATION_KIND_SPECS[kind].channels],
          isDefault: row === undefined,
        };
      }),
    };
  }

  async setRules(
    user: Caller,
    update: NotificationRulesUpdate,
    ctx: AuditContext,
  ): Promise<NotificationRulesView> {
    const allowed = new Set<string>(kindsFor(user.role));
    for (const rule of update.rules) {
      if (!isNotificationKind(rule.kind) || !allowed.has(rule.kind)) {
        throw notificationError(
          400,
          'invalid_rule',
          `"${rule.kind}" is not a kind you can receive`,
        );
      }
      if (rule.telegram && !kindAllowsChannel(rule.kind, 'telegram')) {
        throw notificationError(
          400,
          'invalid_rule',
          `"${rule.kind}" is never sent to Telegram`,
        );
      }
    }
    const before = await this.rules(user);
    await this.prisma.$transaction(
      update.rules.map((rule) =>
        this.prisma.notificationRule.upsert({
          where: { userId_kind: { userId: user.id, kind: rule.kind } },
          update: { inApp: rule.inApp, telegram: rule.telegram },
          create: {
            userId: user.id,
            kind: rule.kind,
            inApp: rule.inApp,
            telegram: rule.telegram,
          },
        }),
      ),
    );
    const after = await this.rules(user);
    const changed = (view: NotificationRulesView) =>
      Object.fromEntries(
        view.rules
          .filter((r) => update.rules.some((u) => u.kind === r.kind))
          .map((r) => [r.kind, { inApp: r.inApp, telegram: r.telegram }]),
      );
    await this.audit.record({
      ...ctx,
      action: 'notification.rules',
      target: { type: 'user', id: user.id },
      before: changed(before),
      after: changed(after),
      result: 'ok',
    });
    return after;
  }

  /** The caller's stored rules by kind. */
  async stored(userId: string): Promise<StoredRules> {
    const rows = await this.prisma.notificationRule.findMany({
      where: { userId },
    });
    return new Map(
      rows.map((r) => [r.kind, { inApp: r.inApp, telegram: r.telegram }]),
    );
  }

  /** The caller's mutes of projects they can still see. */
  async mutes(user: Caller): Promise<NotificationMuteView[]> {
    const rows = await this.prisma.notificationMute.findMany({
      where: { userId: user.id, project: this.access.visibleWhere(user) },
      include: { project: { select: { displayName: true } } },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((row) => ({
      projectId: row.projectId,
      projectName: row.project.displayName,
      until: row.until?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  async mute(
    user: Caller,
    projectId: string,
  ): Promise<NotificationMuteView | null> {
    await this.requireVisible(user, projectId);
    const row = await this.prisma.notificationMute.findUnique({
      where: { userId_projectId: { userId: user.id, projectId } },
      include: { project: { select: { displayName: true } } },
    });
    return row
      ? {
          projectId: row.projectId,
          projectName: row.project.displayName,
          until: row.until?.toISOString() ?? null,
          createdAt: row.createdAt.toISOString(),
        }
      : null;
  }

  async setMute(
    user: Caller,
    projectId: string,
    until: Date | null,
    ctx: AuditContext,
  ): Promise<NotificationMuteView> {
    await this.requireVisible(user, projectId);
    const row = await this.prisma.notificationMute.upsert({
      where: { userId_projectId: { userId: user.id, projectId } },
      update: { until },
      create: { userId: user.id, projectId, until },
      include: { project: { select: { displayName: true } } },
    });
    await this.audit.record({
      ...ctx,
      action: 'notification.mute',
      target: { type: 'project', id: projectId },
      projectId,
      after: { muted: true, until: row.until },
      result: 'ok',
    });
    return {
      projectId: row.projectId,
      projectName: row.project.displayName,
      until: row.until?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    };
  }

  async unmute(
    user: Caller,
    projectId: string,
    ctx: AuditContext,
  ): Promise<void> {
    await this.requireVisible(user, projectId);
    const { count } = await this.prisma.notificationMute.deleteMany({
      where: { userId: user.id, projectId },
    });
    if (count === 0) return;
    await this.audit.record({
      ...ctx,
      action: 'notification.mute',
      target: { type: 'project', id: projectId },
      projectId,
      after: { muted: false },
      result: 'ok',
    });
  }

  private async requireVisible(user: Caller, projectId: string): Promise<void> {
    if (!(await this.access.resolve(user, projectId))) {
      throw mutedProjectNotFound();
    }
  }
}

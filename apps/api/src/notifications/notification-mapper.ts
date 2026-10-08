import type { NotificationKind, NotificationView } from '@agentdock/shared';
import type { Notification } from '@prisma/client';

export type NotificationRow = Notification & {
  project: { displayName: string } | null;
};

/** The select that `toNotificationView` needs. */
export const NOTIFICATION_INCLUDE = {
  project: { select: { displayName: true } },
} as const;

export const toNotificationView = (row: NotificationRow): NotificationView => ({
  id: row.id.toString(),
  kind: row.kind as NotificationKind,
  projectId: row.projectId,
  projectName: row.project?.displayName ?? null,
  runnerId: row.runnerId,
  slot: row.slot,
  issue: row.issue,
  title: row.title,
  body: row.body,
  link: row.link,
  count: row.count,
  firstAt: row.firstAt.toISOString(),
  lastAt: row.lastAt.toISOString(),
  readAt: row.readAt?.toISOString() ?? null,
  muted: row.muted,
});

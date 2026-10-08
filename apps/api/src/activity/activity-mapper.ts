import type { ActivityItem } from '@agentdock/shared';
import type { ActivityItem as ActivityItemRow } from '@prisma/client';
import type { PrismaService } from '../database/prisma.service';

/** Rows as the API returns them, with each user actor's current email. */
export const toActivityItems = async (
  prisma: PrismaService,
  rows: ActivityItemRow[],
): Promise<ActivityItem[]> => {
  const userIds = [
    ...new Set(
      rows
        .filter((r) => r.actorType === 'user' && r.actorId !== null)
        .map((r) => r.actorId as string),
    ),
  ];
  const emails = new Map(
    userIds.length === 0
      ? []
      : (
          await prisma.user.findMany({
            where: { id: { in: userIds } },
            select: { id: true, email: true },
          })
        ).map((u) => [u.id, u.email]),
  );
  return rows.map((row) => ({
    id: row.id.toString(),
    ts: row.ts.toISOString(),
    projectId: row.projectId,
    category: row.category,
    type: row.type,
    severity: row.severity,
    title: row.title,
    actorType: row.actorType,
    actorId: row.actorId,
    actorEmail:
      row.actorType === 'user' && row.actorId
        ? (emails.get(row.actorId) ?? null)
        : null,
    slot: row.slot,
    issue: row.issue,
    prNumber: row.prNumber,
    link: row.link,
    data: (row.data ?? {}) as Record<string, unknown>,
  }));
};

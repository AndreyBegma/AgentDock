import type { Prisma } from '@prisma/client';

/**
 * C-372: whether a demo no longer shows the card's PR, so Telegram does not
 * send it — it recorded another head than the one the PR shows now (C-370
 * supersedes such a demo while it is in flight; this catches one that already
 * finished), or the card has a newer demo that was not skipped. A head that is unknown on either
 * side is not held against the demo.
 */
export const demoOutdated = async (
  db: Pick<Prisma.TransactionClient, 'cardDemo'>,
  demo: { id: string; cardId: string; headSha: string | null; createdAt: Date },
  prHeadSha: string | null,
): Promise<boolean> => {
  if (demo.headSha && prHeadSha && demo.headSha !== prHeadSha) return true;
  const newer = await db.cardDemo.count({
    where: {
      cardId: demo.cardId,
      id: { not: demo.id },
      createdAt: { gt: demo.createdAt },
      status: { not: 'skipped' },
    },
  });
  return newer > 0;
};

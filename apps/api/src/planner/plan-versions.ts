import type {
  PlanTaskVersionView,
  PlanUserRef,
  PlanVersionTurnView,
} from '@agentdock/shared';
import type { PlanTask } from '@prisma/client';

/** A succeeded decompose or revise turn, as the version mapping reads it. */
export interface VersionTurn {
  id: string;
  action: 'decompose' | 'revise';
  author: PlanUserRef;
  finishedAt: Date | null;
  createdAt: Date;
}

const byFinish = (a: VersionTurn, b: VersionTurn): number =>
  (a.finishedAt ?? a.createdAt).getTime() -
    (b.finishedAt ?? b.createdAt).getTime() ||
  a.createdAt.getTime() - b.createdAt.getTime();

/**
 * Which turn produced each plan version (D9). A succeeded revise and the
 * version bump it causes are one transaction, and a failed one changes
 * nothing, so version 1 is the succeeded decompose and version k + 1 the
 * k-th succeeded revise. Pass succeeded turns only; a version no turn
 * accounts for is absent from the map.
 */
export const versionTurns = (
  succeeded: readonly VersionTurn[],
): Map<number, PlanVersionTurnView> => {
  const view = (t: VersionTurn): PlanVersionTurnView => ({
    id: t.id,
    action: t.action,
    author: t.author,
    finishedAt: t.finishedAt?.toISOString() ?? null,
  });
  const map = new Map<number, PlanVersionTurnView>();
  const decompose = [...succeeded]
    .filter((t) => t.action === 'decompose')
    .sort(byFinish)[0];
  if (decompose) map.set(1, view(decompose));
  [...succeeded]
    .filter((t) => t.action === 'revise')
    .sort(byFinish)
    .forEach((t, i) => {
      map.set(i + 2, view(t));
    });
  return map;
};

export const toTaskVersionView = (
  row: PlanTask,
  turn: PlanVersionTurnView | null,
): PlanTaskVersionView => ({
  version: row.planVersion,
  status: row.status,
  frozen: row.frozen,
  title: row.title,
  summary: row.summary,
  document: row.document,
  rewriteComment: row.rewriteComment,
  createdAt: row.createdAt.toISOString(),
  turn,
});

import type { ApprovalItemView, ApprovalUserRef } from '@agentdock/shared';
import type { MergeApproval, Slot, User } from '@prisma/client';

/** A row with the user who decided it. */
export type ApprovalRow = MergeApproval & {
  decidedBy: Pick<User, 'id' | 'name' | 'email'> | null;
};

/** The PR's latest slot, with the summary of its last `pull request open` checkpoint. */
export type ApprovalSlot = Pick<
  Slot,
  'name' | 'issue' | 'prUrl' | 'prChecks' | 'prMergeable'
> & { summary: string | null };

/** The PR as the issue collector (#19) last saw it. */
export interface ApprovalPrCache {
  title: string;
  url: string;
}

export const APPROVAL_ROW_INCLUDE = {
  decidedBy: { select: { id: true, name: true, email: true } },
} as const;

export const userRef = (
  user: Pick<User, 'id' | 'name' | 'email'> | null,
): ApprovalUserRef | null =>
  user ? { id: user.id, name: user.name, email: user.email } : null;

export const toApprovalView = (
  row: ApprovalRow,
  slot: ApprovalSlot | null,
  pr: ApprovalPrCache | null,
): ApprovalItemView => ({
  id: row.id,
  pr: row.prNumber,
  title: pr?.title ?? null,
  url: pr?.url ?? slot?.prUrl ?? null,
  slot: row.slot ?? slot?.name ?? null,
  issue: row.issue ?? slot?.issue ?? null,
  checks: slot?.prChecks ?? null,
  mergeable: slot?.prMergeable ?? null,
  summary: slot?.summary ?? null,
  source: row.source,
  status: row.status,
  headSha: row.headSha,
  waitingSince: row.waitingSince.toISOString(),
  decidedBy: userRef(row.decidedBy),
  decidedAt: row.decidedAt?.toISOString() ?? null,
  note: row.note,
  updatedAt: row.updatedAt.toISOString(),
});

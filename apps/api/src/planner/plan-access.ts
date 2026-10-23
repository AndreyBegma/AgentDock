import type { Prisma } from '@prisma/client';

/**
 * Who may read a plan (D12, D13): its author, or any member of its project
 * once it is `visibility: project`. Site admins are not an exception — a
 * private plan is its author's alone (spec "Open questions"). Project
 * membership is checked by `ProjectAccessGuard` (or `visibleWhere` for
 * `/tasks`); this is the rule on top of it. Every read and every write of a
 * plan goes through it, and a plan it hides answers 404, as if absent.
 */
export const readablePlanWhere = (userId: string): Prisma.PlanWhereInput => ({
  OR: [{ authorId: userId }, { visibility: 'project' }],
});

/**
 * Runs the caller may see in history (L-24): every run but a turn of a plan
 * `readablePlanWhere` hides. A card's or a stack's design turn has no plan and
 * stays visible. Usage applies the same rule in SQL (`UsageQueryService`).
 */
export const readableRunWhere = (userId: string): Prisma.RunWhereInput => ({
  OR: [
    { kind: { not: 'plan' } },
    { planTurn: { is: null } },
    { planTurn: { is: { planId: null } } },
    { planTurn: { is: { plan: { is: readablePlanWhere(userId) } } } },
  ],
});

/** One plan of a project, if the caller may read it. */
export const readablePlan = (
  userId: string,
  projectId: string,
  planId: string,
): Prisma.PlanWhereInput => ({
  id: planId,
  projectId,
  ...readablePlanWhere(userId),
});

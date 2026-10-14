import { WORKFLOW_IDLE_MS } from '@agentdock/shared';
import { Prisma } from '@prisma/client';

/**
 * The definitions of #161 that run in SQL over `session_workflows`, so a
 * route groups 10k sessions in the database instead of reading them. See the
 * contract (`packages/shared/src/workflows`) for what each one means.
 */

/** Compactions in the tree: `none`, `one`, `many` (2 or more). */
export const bucketSql = Prisma.sql`
  CASE WHEN w.compactions <= 0 THEN 'none'
       WHEN w.compactions = 1 THEN 'one'
       ELSE 'many' END`;

/**
 * `active` while the tree had an event within `WORKFLOW_IDLE_MS` of `now`;
 * once ended, `error` before `abandoned` before `completed`.
 */
export const outcomeSql = (now: Date): Prisma.Sql => Prisma.sql`
  CASE WHEN w."lastEventAt" > ${new Date(now.getTime() - WORKFLOW_IDLE_MS)} THEN 'active'
       WHEN w.errored THEN 'error'
       WHEN w."lastTurnOpen" THEN 'abandoned'
       ELSE 'completed' END`;

/** The tree's last event minus the root's start, in ms, never negative. */
export const durationMsSql = Prisma.sql`
  greatest(0, extract(epoch FROM (w."lastEventAt" - w."startedAt")) * 1000)`;

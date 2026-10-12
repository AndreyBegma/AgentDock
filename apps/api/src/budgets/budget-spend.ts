import { Prisma } from '@prisma/client';

type Db = Pick<Prisma.TransactionClient, '$queryRaw'>;

/** What a budget is measured against: one project, or one user (D3). */
export type SpendScope =
  | { scope: 'project'; projectId: string }
  | { scope: 'user'; userId: string };

export interface Spend {
  /** Sum of priced requests; unpriced ones count as zero (D2). */
  spentUsd: Prisma.Decimal;
  unpricedRequests: number;
}

/** An instant as the UTC `timestamp` `llm_requests.ts` is stored as. */
const utc = (at: Date) =>
  Prisma.sql`(${at.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;

/**
 * The sessions whose requests a user started (D3), with every subagent
 * session below them:
 * - a skill run the user started (`triggeredByType = user`): the sessions on
 *   the project's runner whose cwd is the run's worktree or below it (spec 24
 *   D9);
 * - an orchestrator the user started through #17: a slot-less session at the
 *   project root, on that runner, beginning within `matchMs` after an
 *   `orchestrator.start` that ran (`ok` or `unknown`). Of several starts in
 *   that window, the latest one before the session owns it — and when that
 *   start was a schedule firing (#25: its `schedule_firings.commandRunId`),
 *   the session is nobody's, though the run carries the creator's id.
 * Fleet workers (sessions with a slot) are never a user's.
 */
const userSessions = (userId: string, matchMs: number) => Prisma.sql`
  WITH RECURSIVE roots(id) AS (
    SELECT s.id
    FROM runs ru
    JOIN skill_runs sr ON sr."runId" = ru.id AND sr.worktree IS NOT NULL
    JOIN projects p ON p.id = ru."projectId"
    JOIN sessions s ON s."runnerId" = p."runnerId"
      AND (s.cwd = sr.worktree OR left(s.cwd, length(sr.worktree) + 1) = sr.worktree || '/')
    WHERE ru.kind = 'skill'
      AND ru."triggeredByType" = 'user'
      AND ru."triggeredById" = ${userId}
    UNION
    SELECT s.id
    FROM sessions s
    JOIN projects p ON p."runnerId" = s."runnerId" AND p."rootPath" = s.cwd
    WHERE s."slotName" IS NULL
      AND (
        SELECT CASE WHEN EXISTS (
            SELECT 1 FROM schedule_firings sf WHERE sf."commandRunId" = cr.id
          ) THEN NULL ELSE cr."userId" END
        FROM command_runs cr
        WHERE cr."projectId" = p.id
          AND cr.command = 'orchestrator.start'
          AND cr.status IN ('ok', 'unknown')
          AND cr."requestedAt" <= s."startedAt"
          AND s."startedAt" <= cr."requestedAt" + make_interval(secs => ${matchMs / 1000}::double precision)
        ORDER BY cr."requestedAt" DESC
        LIMIT 1
      ) = ${userId}
  ),
  tree(id) AS (
    SELECT id FROM roots
    UNION
    SELECT c.id FROM sessions c JOIN tree t ON c."parentSessionId" = t.id
  )`;

/**
 * The spend of `scope` in `[start, end)`, summed from `llm_requests` with
 * the D3 attribution — the from-scratch figure every evaluation stores
 * (spec 28 notes: amends D4/D5).
 */
export const spendOf = async (
  db: Db,
  scope: SpendScope,
  start: Date,
  end: Date,
  matchMs: number,
): Promise<Spend> => {
  const window = Prisma.sql`r.ts >= ${utc(start)} AND r.ts < ${utc(end)}`;
  const rows =
    scope.scope === 'project'
      ? await db.$queryRaw<{ spent: string; unpriced: number }[]>`
          SELECT coalesce(sum(r."costUsd"), 0)::text AS spent,
                 (count(*) FILTER (WHERE r."costUsd" IS NULL))::int AS unpriced
          FROM llm_requests r
          JOIN sessions s ON s.id = r."sessionId"
          WHERE s."projectId" = ${scope.projectId} AND ${window}`
      : await db.$queryRaw<{ spent: string; unpriced: number }[]>`
          ${userSessions(scope.userId, matchMs)}
          SELECT coalesce(sum(r."costUsd"), 0)::text AS spent,
                 (count(*) FILTER (WHERE r."costUsd" IS NULL))::int AS unpriced
          FROM llm_requests r
          WHERE r."sessionId" IN (SELECT id FROM tree) AND ${window}`;
  const row = rows[0];
  return {
    spentUsd: new Prisma.Decimal(row?.spent ?? '0'),
    unpricedRequests: row?.unpriced ?? 0,
  };
};

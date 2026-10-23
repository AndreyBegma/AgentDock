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
 * The sessions whose requests a user started (D3, D-10), with every subagent
 * session below them:
 * - a skill run the user started (`triggeredByType = user`), or one a schedule
 *   firing started as them (`schedule_firings.principalId`): the sessions on
 *   the project's runner whose cwd is the run's worktree or below it (spec 24
 *   D9);
 * - an orchestrator the user started through #17, by hand or through a
 *   schedule firing that ran as them (#25: its `command_runs.userId` is the
 *   firing's principal): a slot-less session at the project root, on that
 *   runner, beginning within `matchMs` after an `orchestrator.start` that ran
 *   (`ok` or `unknown`). Of several starts in that window, the latest one
 *   before the session owns it.
 * - a manual session the user owns (spec 201 D15): `ownerId`, set from the
 *   runner's local user when its hooks report it.
 * Fleet workers (sessions with a slot) are never a user's.
 */
const userSessions = (userId: string, matchMs: number) => Prisma.sql`
  roots(id) AS (
    SELECT s.id
    FROM sessions s
    WHERE s."ownerId" = ${userId}
    UNION
    SELECT s.id
    FROM runs ru
    JOIN skill_runs sr ON sr."runId" = ru.id AND sr.worktree IS NOT NULL
    JOIN projects p ON p.id = ru."projectId"
    JOIN sessions s ON s."runnerId" = p."runnerId"
      AND (s.cwd = sr.worktree OR left(s.cwd, length(sr.worktree) + 1) = sr.worktree || '/')
    WHERE ru.kind = 'skill'
      AND (
        (ru."triggeredByType" = 'user' AND ru."triggeredById" = ${userId})
        OR EXISTS (
          SELECT 1 FROM schedule_firings sf
          WHERE sf."runId" = ru.id AND sf."principalId" = ${userId}
        )
      )
    UNION
    SELECT s.id
    FROM sessions s
    JOIN projects p ON p."runnerId" = s."runnerId" AND p."rootPath" = s.cwd
    WHERE s."slotName" IS NULL
      AND (
        SELECT cr."userId"
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
 * The sessions of the runs a user started (D-10) that share a session with
 * other runs, each with the run's window — only the requests inside it are
 * the user's:
 * - a board card round (#242 D4): the card's Claude session, which every
 *   round resumes, whoever started it;
 * - a plan turn (spec 172 D14): the task's fork for a task turn, else the
 *   plan's session; a card's or a stack's design turn (#243 D2, #480): its
 *   `designSessionId`;
 * - a UI profile build (spec 223 D13): the slot-less session of the
 *   project in a `.wt-<repo>-uiprofile-*` worktree that began in the run's
 *   window — a project runs one build at a time;
 * - a card review step (#884): its own session, `board_card_review_runs.sessionId`.
 * Every subagent session below one carries the same window.
 */
const userRunSessions = (userId: string) => Prisma.sql`
  started AS (
    SELECT ru.id, ru.kind, ru."projectId", ru."startedAt", ru."endedAt", p."runnerId"
    FROM runs ru
    JOIN projects p ON p.id = ru."projectId"
    WHERE ru.kind IN ('card', 'card_review', 'plan', 'ui_profile')
      AND ru."triggeredByType" = 'user'
      AND ru."triggeredById" = ${userId}
  ),
  run_roots(id, "from", "to") AS (
    SELECT s.id, st."startedAt", st."endedAt"
    FROM started st
    JOIN board_card_rounds cr ON cr."runId" = st.id
    JOIN board_cards c ON c.id = cr."cardId"
    JOIN sessions s ON s."runnerId" = st."runnerId" AND s.runtime = 'claude'
      AND s."externalId" = c."sessionId"::text
    UNION
    SELECT s.id, st."startedAt", st."endedAt"
    FROM started st
    JOIN plan_turns pt ON pt."runId" = st.id
    LEFT JOIN plans pl ON pl.id = pt."planId"
    LEFT JOIN plan_tasks t ON t.id = pt."taskId"
    LEFT JOIN board_cards c ON c.id = pt."cardId"
    LEFT JOIN board_stacks bs ON bs.id = pt."stackId"
    JOIN sessions s ON s."runnerId" = st."runnerId" AND s.runtime = 'claude'
      AND s."externalId" = COALESCE(
        t."sessionId", pl."sessionId", c."designSessionId", bs."designSessionId"
      )::text
    UNION
    SELECT s.id, st."startedAt", st."endedAt"
    FROM started st
    JOIN sessions s ON s."projectId" = st."projectId"
      AND s."runnerId" = st."runnerId"
      AND s."slotName" IS NULL
      AND s.cwd LIKE '%/.wt-%-uiprofile-%'
      AND s."startedAt" >= st."startedAt"
      AND (st."endedAt" IS NULL OR s."startedAt" <= st."endedAt")
    WHERE st.kind = 'ui_profile'
    UNION
    SELECT s.id, st."startedAt", st."endedAt"
    FROM started st
    JOIN board_card_review_runs rr ON rr."runId" = st.id
    JOIN sessions s ON s."runnerId" = st."runnerId" AND s.runtime = 'claude'
      AND s."externalId" = rr."sessionId"::text
  ),
  run_tree(id, "from", "to") AS (
    SELECT id, "from", "to" FROM run_roots
    UNION
    SELECT c.id, t."from", t."to"
    FROM sessions c JOIN run_tree t ON c."parentSessionId" = t.id
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
          WITH RECURSIVE ${userSessions(scope.userId, matchMs)},
          ${userRunSessions(scope.userId)}
          SELECT coalesce(sum(r."costUsd"), 0)::text AS spent,
                 (count(*) FILTER (WHERE r."costUsd" IS NULL))::int AS unpriced
          FROM llm_requests r
          WHERE ${window}
            AND (
              r."sessionId" IN (SELECT id FROM tree)
              OR EXISTS (
                SELECT 1 FROM run_tree rt
                WHERE rt.id = r."sessionId"
                  AND r.ts >= rt."from"
                  AND (rt."to" IS NULL OR r.ts <= rt."to")
              )
            )`;
  const row = rows[0];
  return {
    spentUsd: new Prisma.Decimal(row?.spent ?? '0'),
    unpricedRequests: row?.unpriced ?? 0,
  };
};

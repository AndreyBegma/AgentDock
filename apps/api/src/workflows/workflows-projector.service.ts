import type { Runtime } from '@agentdock/shared/protocol';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { erroredOf, primaryAgentType } from './workflow-metrics';
import { WORKFLOWS_OPTIONS, type WorkflowsOptions } from './workflows-options';

/** Root sessions rebuilt per transaction. */
export const WORKFLOWS_BATCH = 500;
/** Batches one tick runs at most, so a backlog never starves the event loop. */
const MAX_BATCHES_PER_TICK = 50;
const JOB_NAME = 'workflows-projector';
const TRANSACTION_TIMEOUT_MS = 60_000;
/** Subagent nesting followed before a tree is cut: far beyond any real one. */
const MAX_DEPTH = 64;

type Tx = Prisma.TransactionClient;

interface Mark {
  sessionId: string;
  seq: number;
  parentSessionId: string | null;
}

/** One root session's tree, aggregated by SQL; the definitions finish in `workflow-metrics`. */
interface TreeRow {
  sessionId: string;
  projectId: string | null;
  runtime: Runtime;
  profileKey: string | null;
  startedAt: Date;
  lastEventAt: Date;
  depth: number;
  subagents: number;
  compactions: number;
  /** One entry per subagent, null when its type is unknown. */
  agentTypes: Array<string | null>;
  lastErrorAt: Date | null;
  lastRequestAt: Date | null;
  lastTurnOpen: boolean;
}

/**
 * Keeps `session_workflows` and `session_tool_transitions` — one row per root
 * session — for the `/workflows` routes (#161). The workflows sink raises a
 * root's mark when an event reaches its tree; a tick rebuilds every marked
 * root and deletes the mark it built from, unless the sink raised it again
 * meanwhile. A marked session that is no longer a root (it turned out to be
 * a subagent) loses its row. On bootstrap, roots with no row yet are marked:
 * that is the backfill. `sessions` and its children are read only.
 */
@Injectable()
export class WorkflowsProjector
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(WorkflowsProjector.name);
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<number> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly scheduler: SchedulerRegistry,
    @Inject(WORKFLOWS_OPTIONS) private readonly options: WorkflowsOptions,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.options.loop) return;
    void this.backfill()
      .then(() => this.tick())
      .catch((error: unknown) =>
        this.logger.error(
          `workflows backfill failed: ${(error as Error).message}`,
        ),
      );
    this.timer = setInterval(() => {
      void this.tick().catch((error: unknown) =>
        this.logger.error(
          `workflows projection failed: ${(error as Error).message}`,
        ),
      );
    }, this.options.pollMs);
    this.timer.unref();
    this.scheduler.addInterval(JOB_NAME, this.timer);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.scheduler.doesExist('interval', JOB_NAME)) {
      this.scheduler.deleteInterval(JOB_NAME);
    }
  }

  /** Marks every root session that has no row yet; returns how many. */
  backfill(): Promise<number> {
    return this.prisma.$executeRaw`
      INSERT INTO session_workflow_marks ("sessionId")
      SELECT s.id FROM sessions s
      WHERE s."parentSessionId" IS NULL
        AND NOT EXISTS (SELECT 1 FROM session_workflows w WHERE w."sessionId" = s.id)
      ON CONFLICT ("sessionId") DO NOTHING`;
  }

  /** Rebuilds every marked root; returns how many marks it consumed. */
  tick(): Promise<number> {
    this.inFlight ??= this.drain().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async drain(): Promise<number> {
    let done = 0;
    for (let i = 0; i < MAX_BATCHES_PER_TICK; i += 1) {
      const { picked, consumed } = await this.batch();
      done += consumed;
      // A batch whose marks were all raised again meanwhile would be picked
      // again at once: leave those to the next tick.
      if (picked < WORKFLOWS_BATCH || consumed === 0) break;
    }
    return done;
  }

  private batch(): Promise<{ picked: number; consumed: number }> {
    return this.prisma.$transaction(
      async (tx) => {
        // One writer at a time, across API instances too.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('agentdock:workflows'))`;
        const marks = await tx.$queryRaw<Mark[]>`
          SELECT m."sessionId", m.seq, s."parentSessionId"
          FROM session_workflow_marks m JOIN sessions s ON s.id = m."sessionId"
          ORDER BY m."sessionId"
          LIMIT ${WORKFLOWS_BATCH}`;
        if (marks.length === 0) return { picked: 0, consumed: 0 };

        const subagents = marks
          .filter((m) => m.parentSessionId !== null)
          .map((m) => m.sessionId);
        if (subagents.length > 0) {
          await tx.sessionWorkflow.deleteMany({
            where: { sessionId: { in: subagents } },
          });
        }
        const roots = marks
          .filter((m) => m.parentSessionId === null)
          .map((m) => m.sessionId);
        if (roots.length > 0) await this.build(tx, roots);

        const consumed = await tx.$executeRaw`
          DELETE FROM session_workflow_marks m
          USING unnest(${marks.map((m) => m.sessionId)}::text[], ${marks.map((m) => m.seq)}::int[]) AS b(id, seq)
          WHERE m."sessionId" = b.id AND m.seq = b.seq`;
        return { picked: marks.length, consumed };
      },
      { timeout: TRANSACTION_TIMEOUT_MS },
    );
  }

  /** Rewrites the rows of `roots` from their trees. */
  private async build(tx: Tx, roots: string[]): Promise<void> {
    const trees = await tx.$queryRaw<TreeRow[]>`
      WITH RECURSIVE tree(root, id, depth) AS (
        SELECT id, id, 0 FROM sessions WHERE id = ANY(${roots}::text[])
        UNION ALL
        SELECT t.root, s.id, t.depth + 1
        FROM sessions s JOIN tree t ON s."parentSessionId" = t.id
        WHERE t.depth < ${MAX_DEPTH}
      ),
      shape AS (
        SELECT t.root, max(t.depth)::int AS depth, (count(*) - 1)::int AS subagents,
          max(s."lastEventAt") AS "lastEventAt",
          coalesce(json_agg(s."agentType") FILTER (WHERE t.depth > 0), '[]') AS "agentTypes"
        FROM tree t JOIN sessions s ON s.id = t.id GROUP BY t.root
      ),
      compactions AS (
        SELECT t.root, count(*)::int AS n
        FROM tree t JOIN session_compactions c ON c."sessionId" = t.id GROUP BY t.root
      ),
      errors AS (
        SELECT t.root, max(e.ts) AS ts
        FROM tree t JOIN session_errors e ON e."sessionId" = t.id GROUP BY t.root
      ),
      requests AS (
        SELECT t.root, max(r.ts) AS ts
        FROM tree t JOIN llm_requests r ON r."sessionId" = t.id GROUP BY t.root
      ),
      last_turn AS (
        SELECT DISTINCT ON (u."sessionId") u."sessionId" AS root, u."endedAt" IS NULL AS open
        FROM turns u WHERE u."sessionId" = ANY(${roots}::text[])
        ORDER BY u."sessionId", u."startedAt" DESC, u.id DESC
      )
      SELECT r.id AS "sessionId", r."projectId", r.runtime::text AS runtime,
        r."profileKey", r."startedAt", sh."lastEventAt", sh.depth, sh.subagents,
        coalesce(c.n, 0) AS compactions, sh."agentTypes",
        e.ts AS "lastErrorAt", q.ts AS "lastRequestAt",
        coalesce(lt.open, false) AS "lastTurnOpen"
      FROM sessions r
      JOIN shape sh ON sh.root = r.id
      LEFT JOIN compactions c ON c.root = r.id
      LEFT JOIN errors e ON e.root = r.id
      LEFT JOIN requests q ON q.root = r.id
      LEFT JOIN last_turn lt ON lt.root = r.id`;

    const builtAt = new Date();
    const rows = trees.map((t) => ({
      sessionId: t.sessionId,
      projectId: t.projectId,
      runtime: t.runtime,
      profileKey: t.profileKey,
      startedAt: t.startedAt.toISOString(),
      lastEventAt: t.lastEventAt.toISOString(),
      depth: t.depth,
      subagents: t.subagents,
      compactions: t.compactions,
      primaryAgentType: primaryAgentType(t.agentTypes),
      errored: erroredOf(t.lastErrorAt, t.lastRequestAt),
      lastTurnOpen: t.lastTurnOpen,
      builtAt: builtAt.toISOString(),
    }));
    if (rows.length === 0) return;

    await tx.$executeRaw`
      INSERT INTO session_workflows
      SELECT * FROM json_populate_recordset(NULL::session_workflows, ${JSON.stringify(rows)}::json)
      ON CONFLICT ("sessionId") DO UPDATE SET
        "projectId" = EXCLUDED."projectId",
        runtime = EXCLUDED.runtime,
        "profileKey" = EXCLUDED."profileKey",
        "startedAt" = EXCLUDED."startedAt",
        "lastEventAt" = EXCLUDED."lastEventAt",
        depth = EXCLUDED.depth,
        subagents = EXCLUDED.subagents,
        compactions = EXCLUDED.compactions,
        "primaryAgentType" = EXCLUDED."primaryAgentType",
        errored = EXCLUDED.errored,
        "lastTurnOpen" = EXCLUDED."lastTurnOpen",
        "builtAt" = EXCLUDED."builtAt"`;

    const built = rows.map((r) => r.sessionId);
    await tx.$executeRaw`
      DELETE FROM session_tool_transitions WHERE "sessionId" = ANY(${built}::text[])`;
    await tx.$executeRaw`
      WITH RECURSIVE tree(root, id, depth) AS (
        SELECT id, id, 0 FROM sessions WHERE id = ANY(${built}::text[])
        UNION ALL
        SELECT t.root, s.id, t.depth + 1
        FROM sessions s JOIN tree t ON s."parentSessionId" = t.id
        WHERE t.depth < ${MAX_DEPTH}
      ),
      calls AS (
        SELECT t.root, c.name, c.ok,
          lag(c.name) OVER (
            PARTITION BY c."sessionId", c."turnId"
            ORDER BY c."startedAt", c."toolUseId"
          ) AS prev
        FROM tree t JOIN tool_calls c ON c."sessionId" = t.id
      )
      INSERT INTO session_tool_transitions ("sessionId", "from", "to", count, errors)
      SELECT root, prev, name, count(*)::int, (count(*) FILTER (WHERE ok = false))::int
      FROM calls WHERE prev IS NOT NULL
      GROUP BY root, prev, name`;
  }
}

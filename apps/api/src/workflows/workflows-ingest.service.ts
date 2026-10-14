import {
  parseSessionEvent,
  type RunnerEvent,
  type SessionEvent,
} from '@agentdock/shared/protocol';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import {
  type RunnerEventSink,
  RunnerEventSinks,
} from '../runners/runner-event-sinks';

/** A batch of 500 events is a few statements per event at most. */
const BATCH_TRANSACTION_TIMEOUT_MS = 60_000;

/** Parent links followed upwards before a chain is given up as a cycle. */
const MAX_DEPTH = 64;

/**
 * The workflows side of session events (#161). Registered after the sessions
 * sink — `WorkflowsModule` imports `SessionsModule`, whose `onModuleInit`
 * runs first — so every session an event names already has its row. It
 * stores `session.compacted` and `session.error`, a subagent's type from its
 * requests' `agentName`, and marks the root of every touched tree stale for
 * `WorkflowsProjector`. Idempotent: inserts skip what is there, and a
 * re-raised mark only costs a rebuild. Bad events are the sessions sink's to
 * log; they are skipped here silently.
 */
@Injectable()
export class WorkflowsIngestService implements RunnerEventSink, OnModuleInit {
  readonly name = 'workflows';

  constructor(
    private readonly prisma: PrismaService,
    private readonly sinks: RunnerEventSinks,
  ) {}

  onModuleInit(): void {
    this.sinks.register(this);
  }

  async handle(runnerId: string, events: RunnerEvent[]): Promise<void> {
    const parsed: SessionEvent[] = [];
    for (const event of events) {
      const result = parseSessionEvent(event);
      if (result?.ok) parsed.push(result.event);
    }
    if (parsed.length === 0) return;

    await this.prisma.$transaction(
      async (tx) => {
        const ids = await this.sessionIds(tx, runnerId, parsed);
        const compactions: Prisma.SessionCompactionCreateManyInput[] = [];
        const errors: Prisma.SessionErrorCreateManyInput[] = [];
        const agentTypes = new Map<string, string>();

        for (const event of parsed) {
          const sessionId = ids.get(key(event.session));
          if (sessionId === undefined) continue;
          switch (event.type) {
            case 'session.compacted':
              compactions.push({
                sessionId,
                compactionId: event.data.compactionId,
                ts: new Date(event.ts),
                trigger: event.data.trigger,
                preTokens: event.data.preTokens ?? null,
              });
              break;
            case 'session.error':
              errors.push({
                sessionId,
                errorId: event.data.errorId,
                ts: new Date(event.ts),
                kind: event.data.kind,
                status: event.data.status ?? null,
              });
              break;
            case 'llm.request':
              if (event.data.agentName) {
                agentTypes.set(sessionId, event.data.agentName);
              }
              break;
          }
        }

        if (compactions.length > 0) {
          await tx.sessionCompaction.createMany({
            data: compactions,
            skipDuplicates: true,
          });
        }
        if (errors.length > 0) {
          await tx.sessionError.createMany({
            data: errors,
            skipDuplicates: true,
          });
        }
        for (const [id, agentType] of agentTypes) {
          await tx.$executeRaw`
            UPDATE sessions SET "agentType" = ${agentType}
            WHERE id = ${id} AND "agentType" IS DISTINCT FROM ${agentType}`;
        }
        await this.mark(tx, [...new Set(ids.values())]);
      },
      { timeout: BATCH_TRANSACTION_TIMEOUT_MS },
    );
  }

  /** `${runtime}:${externalId}` → session id, for the runner's sessions the batch names. */
  private async sessionIds(
    tx: Prisma.TransactionClient,
    runnerId: string,
    events: readonly SessionEvent[],
  ): Promise<Map<string, string>> {
    const wanted = new Map<string, { runtime: string; id: string }>();
    for (const { session } of events) wanted.set(key(session), session);
    const runtimes = [...wanted.values()].map((s) => s.runtime);
    const externalIds = [...wanted.values()].map((s) => s.id);
    const rows = await tx.$queryRaw<
      { id: string; runtime: string; externalId: string }[]
    >`
      SELECT s.id, s.runtime::text AS runtime, s."externalId"
      FROM sessions s
      JOIN unnest(${runtimes}::text[], ${externalIds}::text[]) AS w(runtime, "externalId")
        ON s.runtime::text = w.runtime AND s."externalId" = w."externalId"
      WHERE s."runnerId" = ${runnerId}`;
    return new Map(
      rows.map((r) => [key({ runtime: r.runtime, id: r.externalId }), r.id]),
    );
  }

  /**
   * Raises the mark of each session's root, and of each session that still
   * has a `session_workflows` row of its own — one that just became a
   * subagent, whose row the projector then drops.
   */
  private async mark(
    tx: Prisma.TransactionClient,
    sessionIds: string[],
  ): Promise<void> {
    if (sessionIds.length === 0) return;
    await tx.$executeRaw`
      WITH RECURSIVE up(id, parent, depth) AS (
        SELECT id, "parentSessionId", 0 FROM sessions WHERE id = ANY(${sessionIds}::text[])
        UNION ALL
        SELECT s.id, s."parentSessionId", u.depth + 1
        FROM sessions s JOIN up u ON s.id = u.parent
        WHERE u.depth < ${MAX_DEPTH}
      ),
      targets AS (
        SELECT id FROM up WHERE parent IS NULL
        UNION
        SELECT "sessionId" FROM session_workflows WHERE "sessionId" = ANY(${sessionIds}::text[])
      )
      INSERT INTO session_workflow_marks ("sessionId")
      SELECT id FROM targets
      ON CONFLICT ("sessionId") DO UPDATE SET seq = session_workflow_marks.seq + 1`;
  }
}

const key = (session: { runtime: string; id: string }): string =>
  `${session.runtime}:${session.id}`;

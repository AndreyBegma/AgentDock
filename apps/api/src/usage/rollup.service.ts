import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

type Tx = Prisma.TransactionClient;

const HOUR_MS = 3_600_000;

/** First key of the per-hour advisory lock — this module's own namespace. */
const ROLLUP_LOCK_NAMESPACE = 13_013;

/** The UTC hour `at` falls in, as epoch milliseconds. */
export const hourOf = (at: Date): number =>
  Math.floor(at.getTime() / HOUR_MS) * HOUR_MS;

/**
 * Keeps `usage_rollups` equal to an aggregation of `llm_requests` (spec 13 D8).
 *
 * Every write rebuilds whole hours from the requests: a re-sent request
 * replaces its usage (spec 12 D4) and a session can move to another project or
 * slot after its requests arrived, so an increment would count twice or under
 * the wrong project. A rebuild is right by construction. Concurrent rebuilds
 * of one hour serialize on an advisory lock per hour, taken in ascending
 * order; under READ COMMITTED the statements after the lock see what the
 * previous holder committed.
 */
@Injectable()
export class RollupService {
  /** Rebuilds the given UTC hours (epoch ms, any order, duplicates allowed) inside `tx`. */
  async rebuildHours(tx: Tx, hours: Iterable<number>): Promise<void> {
    const sorted = [...new Set([...hours].map((h) => hourOf(new Date(h))))]
      .sort((a, b) => a - b)
      .map((h) => new Date(h).toISOString());
    if (sorted.length === 0) return;

    for (const hour of sorted) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(
        ${ROLLUP_LOCK_NAMESPACE}::int,
        (extract(epoch FROM ${hour}::timestamptz) / 3600)::int)`;
    }
    await tx.$executeRaw`
      DELETE FROM usage_rollups WHERE hour = ANY(${sorted}::timestamptz[])`;
    // `ts` is a UTC `timestamp`; an ISO string cast to `timestamp` drops its
    // `Z`, and `AT TIME ZONE 'UTC'` turns the UTC hour into a `timestamptz`.
    // The issue is the slot run of the session's slot that covers the request.
    await tx.$executeRaw`
      INSERT INTO usage_rollups (
        id, hour, "dimensionKey", "projectId", runtime, model, slot, "runId", issue,
        requests, input, output, "cacheRead", "cacheWrite5m", "cacheWrite1h", reasoning,
        "costUsd", "unpricedRequests")
      SELECT
        gen_random_uuid()::text,
        q.h AT TIME ZONE 'UTC',
        json_build_array(q."projectId", q.runtime, q.model, q.slot, NULL, q.issue)::text,
        q."projectId", q.runtime, q.model, q.slot, NULL, q.issue,
        count(*)::int,
        sum(q.input), sum(q.output), sum(q."cacheRead"),
        sum(q."cacheWrite5m"), sum(q."cacheWrite1h"), sum(q.reasoning),
        coalesce(sum(q."costUsd"), 0),
        (count(*) FILTER (WHERE q."costUsd" IS NULL))::int
      FROM (
        SELECT
          h.h, s."projectId", s.runtime, r.model, s."slotName" AS slot,
          (SELECT sl.issue FROM slots sl
            WHERE s."projectId" IS NOT NULL
              AND sl."projectId" = s."projectId"
              AND sl.name = s."slotName"
              AND sl."startedAt" <= r.ts
            ORDER BY sl."startedAt" DESC LIMIT 1) AS issue,
          r.input, r.output, r."cacheRead", r."cacheWrite5m", r."cacheWrite1h",
          r.reasoning, r."costUsd"
        FROM unnest(${sorted}::text[]) AS h0(iso)
        CROSS JOIN LATERAL (SELECT h0.iso::timestamp AS h) h
        JOIN llm_requests r ON r.ts >= h.h AND r.ts < h.h + interval '1 hour'
        JOIN sessions s ON s.id = r."sessionId"
      ) q
      GROUP BY q.h, q."projectId", q.runtime, q.model, q.slot, q.issue`;
  }

  /** Every UTC hour from the one `from` falls in up to `to` (exclusive). */
  hoursBetween(from: Date, to: Date): number[] {
    const hours: number[] = [];
    for (let h = hourOf(from); h < to.getTime(); h += HOUR_MS) hours.push(h);
    return hours;
  }

  /** The hours holding requests of these sessions and every session below them. */
  async hoursOfSessions(tx: Tx, sessionIds: string[]): Promise<number[]> {
    if (sessionIds.length === 0) return [];
    const rows = await tx.$queryRaw<{ hour: Date }[]>`
      WITH RECURSIVE below(id) AS (
        SELECT unnest(${sessionIds}::text[])
        UNION
        SELECT s.id FROM sessions s JOIN below b ON s."parentSessionId" = b.id
      )
      SELECT DISTINCT date_trunc('hour', r.ts) AT TIME ZONE 'UTC' AS hour
      FROM llm_requests r WHERE r."sessionId" IN (SELECT id FROM below)`;
    return rows.map((r) => r.hour.getTime());
  }
}

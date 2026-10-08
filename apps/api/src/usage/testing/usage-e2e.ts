import type { RunnerEvent, TokenBuckets } from '@agentdock/shared/protocol';
import type { PrismaService } from '../../database/prisma.service';
import { SessionsIngestService } from '../../sessions/sessions-ingest.service';
import type { E2eContext } from '../../test/e2e-app';

export const T0 = Date.parse('2026-10-07T18:00:00.000Z');
/** `T0` plus `s` seconds, as ISO. */
export const at = (s: number) => new Date(T0 + s * 1000).toISOString();
export const HOUR = 3600;

export const tokens = (t: Partial<TokenBuckets> = {}): TokenBuckets => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite5m: 0,
  cacheWrite1h: 0,
  reasoning: 0,
  ...t,
});

/** Wire events with consecutive seqs, for one runner. */
export class Events {
  private seq = 0;

  next(
    type: string,
    sessionId: string,
    data: unknown,
    ts: string,
    envelope: Partial<RunnerEvent> = {},
  ): RunnerEvent {
    this.seq += 1;
    return {
      v: 1,
      seq: this.seq,
      ts,
      type,
      source: 'transcript',
      session: { runtime: 'claude', id: sessionId },
      data,
      ...envelope,
    };
  }

  observed(
    sessionId: string,
    ts: string,
    extra: { projectId?: string; slot?: string; parent?: object } = {},
  ): RunnerEvent {
    return this.next(
      'session.observed',
      sessionId,
      { cwd: '/srv/dev/x', startedAt: ts, parsed: true, ...extra },
      ts,
    );
  }

  request(
    sessionId: string,
    requestId: string,
    model: string,
    t: Partial<TokenBuckets>,
    ts: string,
    extra: object = {},
    envelope: Partial<RunnerEvent> = {},
  ): RunnerEvent {
    return this.next(
      'llm.request',
      sessionId,
      { requestId, model, tokens: tokens(t), querySource: 'main', ...extra },
      ts,
      envelope,
    );
  }
}

/**
 * Drops everything usage tests write. `resetDatabase` truncates `users`
 * CASCADE, which reaches runners, sessions and price versions through their
 * foreign keys; `usage_rollups` has none, so it is truncated here.
 */
export const resetUsage = (prisma: PrismaService) =>
  prisma.$executeRawUnsafe(
    'TRUNCATE TABLE usage_rollups, price_recomputes, price_versions, runners, projects CASCADE',
  );

export const runnerRow = (prisma: PrismaService, name = 'desk') =>
  prisma.runner.create({ data: { name }, select: { id: true } });

export const projectRow = (
  prisma: PrismaService,
  runnerId: string,
  name: string,
) =>
  prisma.project.create({
    data: {
      runnerId,
      rootPath: `/srv/dev/${name}`,
      repo: `acme/${name}`,
      displayName: name,
      baseBranch: 'develop',
      baseSource: 'config',
      hasClaudeMd: true,
      hasAgentsMd: false,
      lastInspectedAt: new Date(),
    },
    select: { id: true, rootPath: true, repo: true },
  });

/** Feeds a batch straight to the sessions sink, as the runner gateway does. */
export const ingest = (
  ctx: E2eContext,
  runnerId: string,
  events: RunnerEvent[],
): Promise<void> => ctx.app.get(SessionsIngestService).handle(runnerId, events);

export interface AggregateRow {
  hour: string;
  projectId: string | null;
  runtime: string;
  model: string;
  slot: string | null;
  issue: number | null;
  requests: number;
  unpriced: number;
  input: string;
  output: string;
  cacheRead: string;
  cacheWrite5m: string;
  cacheWrite1h: string;
  reasoning: string;
  cost: string;
}

const ORDER = 'ORDER BY 1, 2 NULLS FIRST, 3, 4, 5 NULLS FIRST, 6 NULLS FIRST';

/** What `usage_rollups` holds, in a comparable shape. */
export const rollupRows = (prisma: PrismaService) =>
  prisma.$queryRawUnsafe<AggregateRow[]>(`
    SELECT to_char(hour AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24') AS hour,
      "projectId", runtime::text AS runtime, model, slot, issue,
      requests, "unpricedRequests" AS unpriced,
      input::text, output::text, "cacheRead"::text, "cacheWrite5m"::text,
      "cacheWrite1h"::text, reasoning::text, "costUsd"::text AS cost
    FROM usage_rollups ${ORDER}`);

/** The same aggregation computed from scratch over `llm_requests`. */
export const fromScratch = (prisma: PrismaService) =>
  prisma.$queryRawUnsafe<AggregateRow[]>(`
    SELECT to_char(date_trunc('hour', r.ts), 'YYYY-MM-DD"T"HH24') AS hour,
      s."projectId", s.runtime::text AS runtime, r.model, s."slotName" AS slot,
      (SELECT sl.issue FROM slots sl
        WHERE s."projectId" IS NOT NULL AND sl."projectId" = s."projectId"
          AND sl.name = s."slotName" AND sl."startedAt" <= r.ts
        ORDER BY sl."startedAt" DESC LIMIT 1) AS issue,
      count(*)::int AS requests,
      (count(*) FILTER (WHERE r."costUsd" IS NULL))::int AS unpriced,
      sum(r.input)::text AS input, sum(r.output)::text AS output,
      sum(r."cacheRead")::text AS "cacheRead",
      sum(r."cacheWrite5m")::text AS "cacheWrite5m",
      sum(r."cacheWrite1h")::text AS "cacheWrite1h",
      sum(r.reasoning)::text AS reasoning,
      coalesce(sum(r."costUsd"), 0)::numeric(14,6)::text AS cost
    FROM llm_requests r JOIN sessions s ON s.id = r."sessionId"
    GROUP BY 1, 2, 3, 4, 5, 6 ${ORDER}`);

import {
  type LiveTopic,
  SESSIONS_CHANGED_LIVE_EVENT,
  type SessionsChangedLiveData,
} from '@agentdock/shared';
import {
  type LlmRequestData,
  parseSessionEvent,
  type RunnerEvent,
  type Runtime,
  runtimeSchema,
  type SessionEvent,
  type SessionObservedData,
  type ToolCallData,
} from '@agentdock/shared/protocol';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { LiveService } from '../live/live.service';
import { CostService, type Pricer } from '../prices/cost.service';
import {
  type RunnerEventSink,
  RunnerEventSinks,
} from '../runners/runner-event-sinks';
import { hourOf, RollupService } from '../usage/rollup.service';
import { modelList } from './session-tree';

type Tx = Prisma.TransactionClient;

/** A batch of 500 events is a few thousand statements at most. */
const BATCH_TRANSACTION_TIMEOUT_MS = 60_000;

interface SessionRef {
  id: string;
  projectId: string | null;
  slotName: string | null;
}

/** State shared by the events of one batch, inside its transaction. */
class BatchContext {
  /** `${runtime}:${externalId}` → the session row. */
  readonly sessions = new Map<string, SessionRef>();
  /** `${sessionId}:${promptId}` → turn id. */
  readonly turns = new Map<string, string>();
  /** Latest event time seen per session id. */
  readonly lastEventAt = new Map<string, Date>();
  /** UTC hours (epoch ms) whose usage rollups this batch changed. */
  readonly rollupHours = new Set<number>();
  /** Sessions whose project or slot changed: their subtrees' hours are rebuilt too. */
  readonly reattributed = new Set<string>();

  constructor(
    readonly tx: Tx,
    readonly runnerId: string,
    readonly pricer: Pricer,
  ) {}

  touch(sessionId: string, at: Date): void {
    const seen = this.lastEventAt.get(sessionId);
    if (!seen || seen < at) this.lastEventAt.set(sessionId, at);
  }
}

/**
 * Projects session events into `sessions`, `turns`, `llm_requests` and
 * `tool_calls` (spec 12). A runner event sink: it runs before the batch is
 * stored, in one transaction, and is idempotent — every write is an upsert on
 * the table's natural key. Malformed events are logged and skipped; a database
 * failure throws, which fails the batch so the runner resends it.
 */
@Injectable()
export class SessionsIngestService implements RunnerEventSink, OnModuleInit {
  readonly name = 'sessions';
  private readonly logger = new Logger(SessionsIngestService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sinks: RunnerEventSinks,
    private readonly live: LiveService,
    private readonly cost: CostService,
    private readonly rollups: RollupService,
  ) {}

  onModuleInit(): void {
    this.sinks.register(this);
  }

  async handle(runnerId: string, events: RunnerEvent[]): Promise<void> {
    const parsed: SessionEvent[] = [];
    for (const event of events) {
      const result = parseSessionEvent(event);
      if (result === null) continue;
      if (!result.ok) {
        this.logger.warn(
          `runner ${runnerId}: skipped ${event.type} seq ${event.seq}: ${result.error}`,
        );
        continue;
      }
      if (!runtimeSchema.safeParse(result.event.session.runtime).success) {
        this.logger.warn(
          `runner ${runnerId}: skipped ${event.type} seq ${event.seq}: unknown runtime`,
        );
        continue;
      }
      parsed.push(result.event);
    }
    if (parsed.length === 0) return;

    const touched = await this.prisma.$transaction(
      async (tx) => {
        const ctx = new BatchContext(tx, runnerId, await this.cost.current(tx));
        for (const event of parsed) await this.apply(ctx, event);
        for (const [id, at] of ctx.lastEventAt) {
          await tx.agentSession.updateMany({
            where: { id, lastEventAt: { lt: at } },
            data: { lastEventAt: at },
          });
        }
        // Spec 13 D8: the usage rollups of every hour this batch changed.
        const moved = await this.rollups.hoursOfSessions(tx, [
          ...ctx.reattributed,
        ]);
        await this.rollups.rebuildHours(tx, [...ctx.rollupHours, ...moved]);
        return [...ctx.lastEventAt.keys()];
      },
      { timeout: BATCH_TRANSACTION_TIMEOUT_MS },
    );
    await this.publish(touched);
  }

  private async apply(ctx: BatchContext, event: SessionEvent): Promise<void> {
    const at = new Date(event.ts);
    const runtime = event.session.runtime as Runtime;
    const session = await this.session(ctx, runtime, event.session.id, at);
    ctx.touch(session.id, at);
    switch (event.type) {
      case 'session.observed':
        return this.observed(ctx, runtime, session, event.data);
      case 'turn.started': {
        await this.turn(ctx, session.id, event.data.promptId, at);
        return;
      }
      case 'turn.finished': {
        const turnId = await this.turn(
          ctx,
          session.id,
          event.data.promptId,
          at,
        );
        await ctx.tx.turn.update({
          where: { id: turnId },
          data: { endedAt: at },
        });
        return;
      }
      case 'llm.request':
        await this.attributeFromEnvelope(ctx, session, event);
        return this.request(ctx, session.id, event.data, at);
      case 'tool.call':
        return this.toolCall(ctx, runtime, session, event.data, at);
    }
  }

  /**
   * The session row for a runtime session id, created as a placeholder
   * (`cwd = ''`) when an event arrives before its `session.observed`.
   */
  private async session(
    ctx: BatchContext,
    runtime: Runtime,
    externalId: string,
    at: Date,
  ): Promise<SessionRef> {
    const key = `${runtime}:${externalId}`;
    const cached = ctx.sessions.get(key);
    if (cached) return cached;
    const select = { id: true, projectId: true, slotName: true } as const;
    const row = await ctx.tx.agentSession.upsert({
      where: {
        runnerId_runtime_externalId: {
          runnerId: ctx.runnerId,
          runtime,
          externalId,
        },
      },
      create: {
        runnerId: ctx.runnerId,
        runtime,
        externalId,
        cwd: '',
        startedAt: at,
        lastEventAt: at,
      },
      update: {},
      select,
    });
    ctx.sessions.set(key, row);
    return row;
  }

  private async observed(
    ctx: BatchContext,
    runtime: Runtime,
    session: SessionRef,
    data: SessionObservedData,
  ): Promise<void> {
    let projectId = data.projectId ?? null;
    if (projectId !== null) {
      // A runner may only place sessions in its own projects.
      const project = await ctx.tx.project.findFirst({
        where: { id: projectId, runnerId: ctx.runnerId },
        select: { id: true },
      });
      if (!project) {
        this.logger.warn(
          `runner ${ctx.runnerId}: session ${session.id} names project ${projectId}, not one of its own; stored without a project`,
        );
        projectId = null;
      }
    }
    let slotName = projectId === null ? null : (data.slot ?? null);
    const before = { projectId: session.projectId, slotName: session.slotName };

    let parentSessionId: string | null = null;
    if (data.parent && data.parent.sessionId !== '') {
      const parent = await this.session(
        ctx,
        runtime,
        data.parent.sessionId,
        new Date(data.startedAt),
      );
      if (parent.id !== session.id) {
        parentSessionId = parent.id;
        // A subagent belongs to its parent's session: same project and slot.
        projectId = parent.projectId;
        slotName = parent.slotName;
        if (data.parent.toolUseId) {
          await ctx.tx.toolCall.updateMany({
            where: { sessionId: parent.id, toolUseId: data.parent.toolUseId },
            data: { childSessionId: session.id },
          });
        }
      }
    }

    await ctx.tx.agentSession.update({
      where: { id: session.id },
      data: {
        profileKey: data.profileKey ?? null,
        cwd: data.cwd,
        gitBranch: data.gitBranch ?? null,
        title: data.title ?? null,
        parsed: data.parsed,
        startedAt: new Date(data.startedAt),
        projectId,
        slotName,
        ...(parentSessionId !== null ? { parentSessionId } : {}),
      },
    });
    session.projectId = projectId;
    session.slotName = slotName;
    if (before.projectId !== projectId || before.slotName !== slotName) {
      ctx.reattributed.add(session.id);
    }
    await this.propagateProject(ctx, session);
  }

  /**
   * Spec 13 D14: live OTel usually arrives before the transcript's
   * `session.observed`, carrying the project and slot on its envelope. A
   * project-less session takes them, but only for a project of the sending
   * runner (the same trust rule as `session.observed`); a later
   * `session.observed` still decides.
   */
  private async attributeFromEnvelope(
    ctx: BatchContext,
    session: SessionRef,
    event: SessionEvent,
  ): Promise<void> {
    if (session.projectId !== null || !event.project) return;
    const project = await ctx.tx.project.findFirst({
      where: { runnerId: ctx.runnerId, rootPath: event.project.root },
      select: { id: true },
    });
    if (!project) return;
    const slotName = event.slot ?? null;
    await ctx.tx.agentSession.update({
      where: { id: session.id },
      data: { projectId: project.id, slotName },
    });
    session.projectId = project.id;
    session.slotName = slotName;
    ctx.reattributed.add(session.id);
    await this.propagateProject(ctx, session);
  }

  /** Every session below `session` takes its project and slot (D10). */
  private async propagateProject(
    ctx: BatchContext,
    session: SessionRef,
  ): Promise<void> {
    await ctx.tx.$executeRaw`
      WITH RECURSIVE below(id) AS (
        SELECT id FROM sessions WHERE "parentSessionId" = ${session.id}
        UNION
        SELECT s.id FROM sessions s JOIN below b ON s."parentSessionId" = b.id
      )
      UPDATE sessions SET "projectId" = ${session.projectId}, "slotName" = ${session.slotName}
      WHERE id IN (SELECT id FROM below) AND id <> ${session.id}`;
    // Cached refs of descendants are now stale: drop them, they reload on use.
    ctx.sessions.forEach((ref, key) => {
      if (ref.id !== session.id) ctx.sessions.delete(key);
    });
  }

  private async turn(
    ctx: BatchContext,
    sessionId: string,
    promptId: string,
    at: Date,
  ): Promise<string> {
    const key = `${sessionId}:${promptId}`;
    const cached = ctx.turns.get(key);
    if (cached) return cached;
    const row = await ctx.tx.turn.upsert({
      where: { sessionId_promptId: { sessionId, promptId } },
      create: { sessionId, promptId, startedAt: at },
      update: {},
      select: { id: true, startedAt: true },
    });
    if (row.startedAt > at) {
      await ctx.tx.turn.update({
        where: { id: row.id },
        data: { startedAt: at },
      });
    }
    ctx.turns.set(key, row.id);
    return row.id;
  }

  private async request(
    ctx: BatchContext,
    sessionId: string,
    data: LlmRequestData,
    at: Date,
  ): Promise<void> {
    const turnId = data.promptId
      ? await this.turn(ctx, sessionId, data.promptId, at)
      : null;
    const source = data.source ?? 'transcript';
    const reported =
      data.reportedCostUsd !== undefined
        ? { reportedCostUsd: new Prisma.Decimal(data.reportedCostUsd) }
        : {};
    const where = {
      sessionId_requestId: { sessionId, requestId: data.requestId },
    };
    const previous = await ctx.tx.llmRequest.findUnique({
      where,
      select: { id: true, ts: true, source: true, durationApprox: true },
    });

    // Spec 13 D15: an OTel copy of a request the transcript already gave
    // keeps the transcript's tokens (they split cache writes by TTL) and adds
    // only what the transcript lacks: the runtime's cost and a measured duration.
    if (previous?.source === 'transcript' && source === 'otel') {
      await ctx.tx.llmRequest.update({
        where: { id: previous.id },
        data: {
          ...reported,
          ...(previous.durationApprox && data.durationMs !== undefined
            ? { durationMs: data.durationMs, durationApprox: false }
            : {}),
          ...(turnId !== null ? { turnId } : {}),
        },
      });
      return;
    }

    // Otherwise the incoming tokens win: D4's last usage from one producer,
    // or the transcript's exact split over OTel's.
    const measured =
      previous?.source === 'otel' &&
      source === 'transcript' &&
      (data.durationMs === undefined || data.durationApprox === true);
    const fields = {
      ts: at,
      model: data.model,
      querySource: data.querySource,
      ...data.tokens,
      ...(measured
        ? {}
        : {
            durationMs: data.durationMs ?? null,
            durationApprox: data.durationApprox ?? false,
          }),
      stopReason: data.stopReason ?? null,
      source,
      cacheWriteTtlUnknown: data.cacheWriteTtlUnknown ?? false,
      ...reported,
      // Spec 13 D6: priced in the transaction that stores it.
      ...ctx.pricer.price(data.model, data.tokens),
    };
    // A re-sent request may move to another hour: both hours are rebuilt.
    if (previous) ctx.rollupHours.add(hourOf(previous.ts));
    ctx.rollupHours.add(hourOf(at));
    await ctx.tx.llmRequest.upsert({
      where,
      create: { sessionId, requestId: data.requestId, turnId, ...fields },
      update: { ...fields, ...(turnId !== null ? { turnId } : {}) },
    });
    const { models } = await ctx.tx.agentSession.findUniqueOrThrow({
      where: { id: sessionId },
      select: { models: true },
    });
    const list = modelList(models);
    if (!list.includes(data.model)) {
      await ctx.tx.agentSession.update({
        where: { id: sessionId },
        data: { models: [...list, data.model] },
      });
    }
  }

  private async toolCall(
    ctx: BatchContext,
    runtime: Runtime,
    session: SessionRef,
    data: ToolCallData,
    at: Date,
  ): Promise<void> {
    const turnId = data.promptId
      ? await this.turn(ctx, session.id, data.promptId, at)
      : null;

    let childSessionId: string | null = null;
    if (data.childSessionId) {
      const child = await this.session(
        ctx,
        runtime,
        data.childSessionId,
        new Date(data.startedAt),
      );
      if (child.id !== session.id) {
        childSessionId = child.id;
        if (
          child.projectId !== session.projectId ||
          child.slotName !== session.slotName
        ) {
          ctx.reattributed.add(child.id);
        }
        await ctx.tx.agentSession.update({
          where: { id: child.id },
          data: {
            parentSessionId: session.id,
            projectId: session.projectId,
            slotName: session.slotName,
          },
        });
        child.projectId = session.projectId;
        child.slotName = session.slotName;
        await this.propagateProject(ctx, child);
      }
    }

    const optional = {
      ...(data.endedAt ? { endedAt: new Date(data.endedAt) } : {}),
      ...(data.ok !== undefined ? { ok: data.ok } : {}),
      ...(childSessionId !== null ? { childSessionId } : {}),
      ...(turnId !== null ? { turnId } : {}),
    };
    await ctx.tx.toolCall.upsert({
      where: {
        sessionId_toolUseId: {
          sessionId: session.id,
          toolUseId: data.toolUseId,
        },
      },
      create: {
        sessionId: session.id,
        toolUseId: data.toolUseId,
        name: data.tool,
        startedAt: new Date(data.startedAt),
        ...optional,
      },
      update: { name: data.tool, ...optional },
    });
    if (data.endedAt) ctx.touch(session.id, new Date(data.endedAt));
  }

  /** Tells the web which sessions changed: per project, and to admins for unassigned ones. */
  private async publish(sessionIds: string[]): Promise<void> {
    if (sessionIds.length === 0) return;
    const rows = await this.prisma.agentSession.findMany({
      where: { id: { in: sessionIds } },
      select: { id: true, projectId: true },
    });
    const byTopic = new Map<LiveTopic, string[]>();
    for (const row of rows) {
      const topic: LiveTopic =
        row.projectId === null ? 'admin' : `project:${row.projectId}`;
      const list = byTopic.get(topic);
      if (list) list.push(row.id);
      else byTopic.set(topic, [row.id]);
    }
    for (const [topic, ids] of byTopic) {
      const data: SessionsChangedLiveData = { sessionIds: ids };
      try {
        this.live.publish(topic, SESSIONS_CHANGED_LIVE_EVENT, data);
      } catch (error) {
        this.logger.warn(
          `live ${SESSIONS_CHANGED_LIVE_EVENT} on ${topic}: ${(error as Error).message}`,
        );
      }
    }
  }
}

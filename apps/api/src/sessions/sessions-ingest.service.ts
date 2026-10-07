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
import {
  type RunnerEventSink,
  RunnerEventSinks,
} from '../runners/runner-event-sinks';
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

  constructor(
    readonly tx: Tx,
    readonly runnerId: string,
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
        const ctx = new BatchContext(tx, runnerId);
        for (const event of parsed) await this.apply(ctx, event);
        for (const [id, at] of ctx.lastEventAt) {
          await tx.agentSession.updateMany({
            where: { id, lastEventAt: { lt: at } },
            data: { lastEventAt: at },
          });
        }
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
    const fields = {
      ts: at,
      model: data.model,
      querySource: data.querySource,
      ...data.tokens,
      durationMs: data.durationMs ?? null,
      durationApprox: data.durationApprox ?? false,
      stopReason: data.stopReason ?? null,
    };
    // D4: the last usage seen for a requestId wins.
    await ctx.tx.llmRequest.upsert({
      where: { sessionId_requestId: { sessionId, requestId: data.requestId } },
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

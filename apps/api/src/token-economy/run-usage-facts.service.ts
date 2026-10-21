import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { PrismaService } from '../database/prisma.service';
import {
  type UsageFact,
  usageFactsByRun,
  usageFactsBySession,
} from './usage-facts';

const JOB_NAME = 'run-usage-facts';
/** The sweep is the debounce: one rebuild pass per interval. */
const SWEEP_MS = 5 * 60_000;
/** Requests may still arrive this long after a run or session ends. */
const LATE_MS = 24 * 3_600_000;
const BATCH = 200;

const EMPTY_FACT: UsageFact = {
  input: 0n,
  output: 0n,
  cacheRead: 0n,
  cacheWrite5m: 0n,
  cacheWrite1h: 0n,
  costUsd: null,
  unpricedRequests: 0,
  compactions: 0,
  peakContext: 0,
  turns: 0,
  subagentCostUsd: null,
};

/**
 * #746: `run_usage_facts` — one row per ended card run and manual session.
 * Every `SWEEP_MS` the sweep (re)builds the facts that are missing, and those
 * of runs and sessions ended less than `LATE_MS` ago, when late `llm_requests`
 * may still change them. The report builds its cards' missing facts first.
 */
@Injectable()
export class RunUsageFactsService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(RunUsageFactsService.name);
  private timer: NodeJS.Timeout | undefined;
  private inFlight: Promise<number> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly scheduler: SchedulerRegistry,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.get<string>('APP_ENV') === 'test') return;
    this.timer = setInterval(() => {
      void this.sweep().catch((error: unknown) =>
        this.logger.error(`usage facts sweep failed: ${String(error)}`),
      );
    }, SWEEP_MS);
    this.timer.unref();
    this.scheduler.addInterval(JOB_NAME, this.timer);
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
    if (this.scheduler.doesExist('interval', JOB_NAME)) {
      this.scheduler.deleteInterval(JOB_NAME);
    }
  }

  /** One pass; returns how many facts it wrote. */
  sweep(now = new Date()): Promise<number> {
    this.inFlight ??= this.drain(now).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async drain(now: Date): Promise<number> {
    const recent = new Date(now.getTime() - LATE_MS);
    const [runs, sessions] = await Promise.all([
      this.prisma.run.findMany({
        where: {
          kind: 'card',
          endedAt: { not: null },
          OR: [{ usageFact: null }, { endedAt: { gte: recent } }],
        },
        select: { id: true },
        orderBy: { endedAt: 'desc' },
        take: BATCH,
      }),
      this.prisma.agentSession.findMany({
        where: {
          origin: 'manual',
          parentSessionId: null,
          projectId: { not: null },
          endedAt: { not: null },
          OR: [{ usageFact: null }, { endedAt: { gte: recent } }],
        },
        select: { id: true },
        orderBy: { endedAt: 'desc' },
        take: BATCH,
      }),
    ]);
    return (
      (await this.buildRuns(
        runs.map((r) => r.id),
        now,
      )) +
      (await this.buildSessions(
        sessions.map((s) => s.id),
        now,
      ))
    );
  }

  /** Builds the facts of the given ended runs that have none yet. */
  async ensureRuns(runIds: string[], now = new Date()): Promise<number> {
    if (runIds.length === 0) return 0;
    const missing = await this.prisma.run.findMany({
      where: { id: { in: runIds }, endedAt: { not: null }, usageFact: null },
      select: { id: true },
    });
    return this.buildRuns(
      missing.map((r) => r.id),
      now,
    );
  }

  /** (Re)builds the facts of some runs; a run without requests gets zeros. */
  async buildRuns(runIds: string[], now = new Date()): Promise<number> {
    if (runIds.length === 0) return 0;
    const [facts, runs] = await Promise.all([
      usageFactsByRun(this.prisma, runIds),
      this.prisma.run.findMany({
        where: { id: { in: runIds } },
        select: { id: true, projectId: true },
      }),
    ]);
    for (const run of runs) {
      const data = {
        ...(facts.get(run.id) ?? EMPTY_FACT),
        projectId: run.projectId,
        builtAt: now,
      };
      await this.prisma.runUsageFact.upsert({
        where: { runId: run.id },
        create: { runId: run.id, ...data },
        update: data,
      });
    }
    return runs.length;
  }

  /** (Re)builds the facts of some manual sessions. */
  async buildSessions(sessionIds: string[], now = new Date()): Promise<number> {
    if (sessionIds.length === 0) return 0;
    const [facts, sessions] = await Promise.all([
      usageFactsBySession(this.prisma, sessionIds),
      this.prisma.agentSession.findMany({
        where: { id: { in: sessionIds }, projectId: { not: null } },
        select: { id: true, projectId: true },
      }),
    ]);
    let written = 0;
    for (const session of sessions) {
      if (session.projectId === null) continue;
      const data = {
        ...(facts.get(session.id) ?? EMPTY_FACT),
        projectId: session.projectId,
        builtAt: now,
      };
      await this.prisma.runUsageFact.upsert({
        where: { sessionId: session.id },
        create: { sessionId: session.id, ...data },
        update: data,
      });
      written += 1;
    }
    return written;
  }
}

import {
  RUN_UPDATED_LIVE_EVENT,
  type RunLiveChange,
  runTopic,
  SKILL_RUN_PHASE_LIVE_EVENT,
  type SkillRunPhaseLiveChange,
} from '@agentdock/shared';
import {
  isSkillRunEventType,
  isTerminalSkillRunPhase,
  type RunnerEvent,
  type SkillRunFinishedData,
  type SkillRunPhase,
  type SkillRunPhaseChangedData,
  skillPhaseToRunStatus,
  skillRunEventDataSchemas,
} from '@agentdock/shared/protocol';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../database/prisma.service';
import { LiveService } from '../live/live.service';
import {
  type RunnerEventSink,
  RunnerEventSinks,
} from '../runners/runner-event-sinks';

/** `runs.outcome`: why it failed, else the report's first line. */
const OUTCOME_MAX = 500;
const outcomeOf = (data: SkillRunFinishedData): string | null => {
  const text = data.error ?? data.reportText?.split('\n', 1)[0] ?? '';
  return text.trim() === '' ? null : text.slice(0, OUTCOME_MAX);
};

/**
 * Applies `skill_run.phase_changed` and `skill_run.finished` (spec 24 D10,
 * D12) to `skill_runs` and #21's `runs`. A run is touched only by the runner
 * of its project, a terminal phase is never left, and `finished` lands once —
 * replays of a batch change nothing. Only the D10 report fields are stored.
 */
@Injectable()
export class SkillRunProjector implements RunnerEventSink, OnModuleInit {
  readonly name = 'skills';
  private readonly logger = new Logger(SkillRunProjector.name);

  constructor(
    private readonly sinks: RunnerEventSinks,
    private readonly prisma: PrismaService,
    private readonly live: LiveService,
    private readonly audit: AuditService,
  ) {}

  onModuleInit(): void {
    this.sinks.register(this);
  }

  async handle(runnerId: string, events: RunnerEvent[]): Promise<void> {
    for (const event of events) {
      if (!isSkillRunEventType(event.type)) continue;
      const parsed = skillRunEventDataSchemas[event.type].safeParse(event.data);
      if (!parsed.success) {
        this.logger.warn(
          `runner ${runnerId}: malformed ${event.type} (seq ${event.seq}), skipped`,
        );
        continue;
      }
      if (event.type === 'skill_run.phase_changed') {
        await this.phaseChanged(
          runnerId,
          parsed.data as SkillRunPhaseChangedData,
        );
      } else {
        await this.finished(runnerId, parsed.data as SkillRunFinishedData);
      }
    }
  }

  /** The run, if it belongs to `projectId` on this runner. */
  private async runOf(runnerId: string, runId: string, projectId: string) {
    const row = await this.prisma.skillRun.findFirst({
      where: {
        runId,
        run: { projectId, kind: 'skill', project: { runnerId } },
      },
      include: { run: { select: { startedAt: true } } },
    });
    if (!row) {
      this.logger.warn(
        `runner ${runnerId}: skill run ${runId} of project ${projectId} not found, skipped`,
      );
    }
    return row;
  }

  private async phaseChanged(
    runnerId: string,
    data: SkillRunPhaseChangedData,
  ): Promise<void> {
    const row = await this.runOf(runnerId, data.runId, data.projectId);
    if (!row || isTerminalSkillRunPhase(row.phase)) return;
    const at = new Date(data.at);
    const terminal = isTerminalSkillRunPhase(data.phase);
    const updated = await this.prisma.skillRun.updateMany({
      where: { runId: data.runId, phase: row.phase },
      data: {
        phase: data.phase,
        ...(data.tmuxSession ? { tmuxSession: data.tmuxSession } : {}),
        ...(data.worktree ? { worktree: data.worktree } : {}),
        ...(data.branch ? { branch: data.branch } : {}),
        ...(data.phase === 'running' && !row.startedAt
          ? { startedAt: at }
          : {}),
        ...(terminal ? { finishedAt: at } : {}),
      },
    });
    if (updated.count === 0) return;
    const run = await this.prisma.run.update({
      where: { id: data.runId },
      data: {
        status: skillPhaseToRunStatus(data.phase),
        updatedAt: new Date(),
        ...(terminal
          ? {
              endedAt: at,
              durationMs: Math.max(
                0,
                at.getTime() - row.run.startedAt.getTime(),
              ),
            }
          : {}),
      },
      select: { id: true, status: true },
    });
    this.publish(data.projectId, data.phase, run);
  }

  private async finished(
    runnerId: string,
    data: SkillRunFinishedData,
  ): Promise<void> {
    const row = await this.runOf(runnerId, data.runId, data.projectId);
    if (!row) return;
    const at = new Date(data.finishedAt);
    const outcome = outcomeOf(data);
    // `changedFilesTotal` is written by `finished` only: the once-marker.
    const applied = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.skillRun.updateMany({
        where: { runId: data.runId, changedFilesTotal: null },
        data: {
          phase: data.phase,
          finishedAt: at,
          exitCode: data.exitCode,
          reportText: data.reportText ?? null,
          reportTruncated: data.reportTruncated,
          changedFiles: data.changedFiles,
          changedFilesTotal: data.changedFilesTotal,
          patch: data.patch ?? null,
          patchTruncated: data.patchTruncated,
          error: data.error ?? null,
          prNumber: data.prNumber ?? null,
          prUrl: data.prUrl ?? null,
        },
      });
      if (updated.count === 0) return null;
      return tx.run.update({
        where: { id: data.runId },
        data: {
          status: skillPhaseToRunStatus(data.phase),
          outcome,
          prNumber: data.prNumber ?? null,
          prUrl: data.prUrl ?? null,
          endedAt: at,
          durationMs: Math.max(0, at.getTime() - row.run.startedAt.getTime()),
          updatedAt: new Date(),
        },
        select: { id: true, status: true },
      });
    });
    if (!applied) return;
    await this.audit.record({
      actor: { type: 'runner', runnerId },
      action: 'skill.run_finished',
      target: { type: 'run', id: data.runId },
      projectId: data.projectId,
      after: {
        skill: row.skill,
        phase: data.phase,
        exitCode: data.exitCode,
        changedFiles: data.changedFilesTotal,
        prUrl: data.prUrl ?? null,
      },
      result: data.phase === 'succeeded' ? 'ok' : 'error',
    });
    this.publish(data.projectId, data.phase, applied);
  }

  /** Best effort, like every live update. */
  private publish(
    projectId: string,
    phase: SkillRunPhase,
    run: RunLiveChange,
  ): void {
    try {
      this.live.publish(`project:${projectId}`, RUN_UPDATED_LIVE_EVENT, run);
      this.live.publish(
        runTopic(projectId, run.id),
        SKILL_RUN_PHASE_LIVE_EVENT,
        {
          runId: run.id,
          phase,
          status: run.status,
        } satisfies SkillRunPhaseLiveChange,
      );
    } catch (error) {
      this.logger.warn(
        `skill run ${run.id} update not published: ${(error as Error).message}`,
      );
    }
  }
}

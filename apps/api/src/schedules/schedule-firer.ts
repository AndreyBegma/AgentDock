import {
  projectRoleAtLeast,
  type Role,
  SCHEDULE_DEFAULT_MODEL,
  SCHEDULE_FIRING_REASONS,
  SCHEDULE_MAX_CONSECUTIVE_FAILURES,
  type ScheduleDisabledReason,
  type ScheduleFiringReason,
  type ScheduleTarget,
  SKILLS_ERROR,
} from '@agentdock/shared';
import { HttpException, Injectable, Logger } from '@nestjs/common';
import type {
  Prisma,
  Schedule,
  ScheduleFiring,
  ScheduleFiringStatus,
} from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { SYSTEM_ACTOR } from '../audit/audit.types';
import { ControlService } from '../control/control.service';
import { PrismaService } from '../database/prisma.service';
import { ProjectAccessService } from '../projects';
import { RunnerPresence } from '../runners/runner-presence';
import { SkillRunService } from '../skills';
import { BeforeFire } from './before-fire';
import { ScheduleLive } from './schedule-live';
import { parseTarget } from './target';

/** How a sent firing ended, before it is written. */
interface Outcome {
  status: Exclude<ScheduleFiringStatus, 'due'>;
  reason?: ScheduleFiringReason;
  runId?: string;
  commandRunId?: string;
  error?: { code: string; message?: string };
  /** The command reached the runner (or was answered by it). */
  sent: boolean;
}

/** The body of an API error the fired service threw, read structurally. */
const errorBody = (
  error: unknown,
): {
  code: string;
  message?: string;
  runId?: string;
  commandRunId?: string;
} | null => {
  if (!(error instanceof HttpException)) return null;
  const body = error.getResponse();
  if (typeof body !== 'object' || body === null) {
    return { code: 'error', message: String(body) };
  }
  const record = body as Record<string, unknown>;
  const text = (key: string) =>
    typeof record[key] === 'string' ? (record[key] as string) : undefined;
  return {
    code: text('error') ?? 'error',
    message: text('message'),
    runId: text('runId'),
    commandRunId: text('commandRunId'),
  };
};

/**
 * Fires one `due` firing (D7–D11, D15): the pre-fire hook, the creator's
 * authority at fire time, overlap, the runner's presence, then the target's
 * command through the same service a person's click goes through —
 * `SkillRunService.start` (#24) or `ControlService.start` (#17). Never a new
 * path to the runner.
 */
@Injectable()
export class ScheduleFirer {
  private readonly logger = new Logger(ScheduleFirer.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ProjectAccessService,
    private readonly presence: RunnerPresence,
    private readonly skillRuns: SkillRunService,
    private readonly control: ControlService,
    private readonly beforeFire: BeforeFire,
    private readonly audit: AuditService,
    private readonly live: ScheduleLive,
  ) {}

  /** Fires `firingId` if it is still `due`; returns the firing as it ends. */
  async fire(firingId: bigint): Promise<ScheduleFiring> {
    const firing = await this.prisma.scheduleFiring.findUniqueOrThrow({
      where: { id: firingId },
      include: {
        schedule: {
          include: {
            project: { select: { runnerId: true } },
            createdBy: {
              select: { id: true, email: true, role: true, status: true },
            },
          },
        },
      },
    });
    if (firing.status !== 'due') return firing;
    const { schedule } = firing;
    const { project, createdBy, ...row } = schedule;

    const decision = await this.beforeFire.check(row, firing);
    if (!decision.allow) {
      return this.settle(firing, {
        status: 'skipped',
        reason: SCHEDULE_FIRING_REASONS.denied,
        error: { code: 'denied', message: decision.reason },
        sent: false,
      });
    }

    // D10: the creator's authority now, not when the schedule was saved.
    const role = await this.creatorRole(createdBy, schedule.projectId);
    if (!role) {
      const settled = await this.settle(firing, {
        status: 'failed',
        reason: SCHEDULE_FIRING_REASONS.creatorNotAuthorized,
        sent: false,
      });
      await this.disable(schedule, 'creator_not_authorized');
      return settled;
    }

    // D7: one schedule never has two live runs.
    const live = await this.prisma.scheduleFiring.findFirst({
      where: {
        scheduleId: schedule.id,
        id: { not: firing.id },
        status: 'started',
        // The projector may not have seen its run end yet.
        run: { status: 'running' },
      },
      select: { id: true },
    });
    if (live) {
      return this.settle(firing, {
        status: 'skipped',
        reason: SCHEDULE_FIRING_REASONS.previousStillRunning,
        sent: false,
      });
    }

    // D9: checked before anything is sent or recorded elsewhere.
    if (!this.presence.isConnected(project.runnerId)) {
      const settled = await this.settle(firing, {
        status: 'failed',
        reason: SCHEDULE_FIRING_REASONS.runnerOffline,
        sent: false,
      });
      // `catch_up`: the occurrence is retried once when the runner is back.
      if (schedule.missedPolicy === 'catch_up' && firing.kind === 'cron') {
        await this.prisma.schedule.updateMany({
          where: { id: schedule.id, enabled: true },
          data: { nextRunAt: firing.scheduledFor },
        });
      }
      return settled;
    }

    const target = parseTarget(schedule.target);
    const outcome = await this.send(row, target, role, createdBy).catch(
      (error: unknown): Outcome => {
        const body = errorBody(error);
        if (!body) throw error;
        return this.failure(body);
      },
    );
    return this.settle(firing, outcome);
  }

  /**
   * D11: a firing's final status, written once (only from `due` or
   * `started`), with the schedule's failure counter and auto-disable.
   */
  async settle(
    firing: ScheduleFiring,
    outcome: Outcome,
  ): Promise<ScheduleFiring> {
    const now = new Date();
    const terminal = outcome.status !== 'started';
    const updated = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.scheduleFiring.updateMany({
        where: { id: firing.id, status: firing.status },
        data: {
          status: outcome.status,
          reason: outcome.reason ?? null,
          ...(outcome.sent && !firing.firedAt ? { firedAt: now } : {}),
          ...(outcome.runId ? { runId: outcome.runId } : {}),
          ...(outcome.commandRunId
            ? { commandRunId: outcome.commandRunId }
            : {}),
          ...(outcome.error ? { error: outcome.error } : {}),
          ...(terminal ? { finishedAt: now } : {}),
        },
      });
      if (count === 0) return null;
      await this.count(tx, firing.scheduleId, outcome, now);
      return tx.scheduleFiring.findUniqueOrThrow({ where: { id: firing.id } });
    });
    if (!updated) {
      return this.prisma.scheduleFiring.findUniqueOrThrow({
        where: { id: firing.id },
      });
    }
    const schedule = await this.prisma.schedule.findUnique({
      where: { id: firing.scheduleId },
    });
    if (schedule) {
      this.live.firing(schedule.projectId, updated);
      if (
        updated.status === 'failed' &&
        schedule.enabled &&
        schedule.consecutiveFailures >= SCHEDULE_MAX_CONSECUTIVE_FAILURES
      ) {
        await this.disable(schedule, 'failing');
      }
    }
    return updated;
  }

  /** D10, D11: disables a schedule on the system's behalf, audited. */
  async disable(
    schedule: Schedule,
    reason: Exclude<ScheduleDisabledReason, 'manual'>,
  ): Promise<void> {
    const { count } = await this.prisma.schedule.updateMany({
      where: { id: schedule.id, enabled: true },
      data: { enabled: false, disabledReason: reason, nextRunAt: null },
    });
    if (count === 0) return;
    await this.audit.record({
      actor: SYSTEM_ACTOR,
      action: 'schedule.disable',
      target: { type: 'schedule', id: schedule.id },
      projectId: schedule.projectId,
      before: { enabled: true },
      after: { enabled: false, disabledReason: reason },
      result: 'ok',
      meta: { consecutiveFailures: schedule.consecutiveFailures },
    });
    this.live.disabled(schedule.projectId, schedule.id, reason);
  }

  private async count(
    tx: Prisma.TransactionClient,
    scheduleId: string,
    outcome: Outcome,
    now: Date,
  ): Promise<void> {
    const lastRun = outcome.sent ? { lastRunAt: now } : {};
    if (outcome.status === 'failed') {
      await tx.schedule.update({
        where: { id: scheduleId },
        data: { consecutiveFailures: { increment: 1 }, ...lastRun },
      });
    } else if (outcome.status === 'succeeded') {
      await tx.schedule.update({
        where: { id: scheduleId },
        data: { consecutiveFailures: 0, ...lastRun },
      });
    } else if (outcome.sent) {
      await tx.schedule.update({ where: { id: scheduleId }, data: lastRun });
    }
  }

  /** The creator's effective role if they may still fire it (operator+, active); else null. */
  private async creatorRole(
    creator: { id: string; role: Role; status: string },
    projectId: string,
  ): Promise<Role | null> {
    if (creator.status !== 'active') return null;
    const access = await this.access.resolve(creator, projectId);
    if (!access || !projectRoleAtLeast(access.role, 'operator')) return null;
    return access.role;
  }

  private async send(
    schedule: Schedule,
    target: ScheduleTarget,
    role: Role,
    creator: { id: string; email: string },
  ): Promise<Outcome> {
    // D8: sent as the system, with the creator's role; the person is
    // reachable through the run's trigger (`triggeredById` → schedule).
    const ctx = { actor: SYSTEM_ACTOR };
    if (target.kind === 'skill') {
      const profileKey = await this.profileKey(target.profileId);
      const run = await this.skillRuns.start(
        schedule.projectId,
        {
          skill: target.skill,
          args: target.args,
          ...(profileKey ? { profileKey } : {}),
          model: target.model ?? SCHEDULE_DEFAULT_MODEL,
          output: target.output,
        },
        { type: 'schedule', id: schedule.id, role, ctx },
      );
      return { status: 'started', runId: run.runId, sent: true };
    }
    const commandRun = await this.control.start(
      { projectId: schedule.projectId, role, user: creator, ctx },
      { mode: target.mode },
    );
    // The orchestrator's own rounds are runs of their own (spec 25 notes, Q1).
    return { status: 'succeeded', commandRunId: commandRun.id, sent: true };
  }

  /** A stored `profileId` as the key `skill.run` takes; a deleted profile falls back to the default. */
  private async profileKey(profileId: string | undefined) {
    if (!profileId) return undefined;
    const profile = await this.prisma.runtimeProfile.findUnique({
      where: { id: profileId },
      select: { key: true },
    });
    return profile?.key;
  }

  private failure(body: NonNullable<ReturnType<typeof errorBody>>): Outcome {
    const error = {
      code: body.code,
      ...(body.message ? { message: body.message } : {}),
    };
    const ids = {
      ...(body.runId ? { runId: body.runId } : {}),
      ...(body.commandRunId ? { commandRunId: body.commandRunId } : {}),
    };
    switch (body.code) {
      // D8: the orchestrator is already up — the schedule's intent holds.
      case 'already_running':
        return {
          status: 'noop',
          reason: SCHEDULE_FIRING_REASONS.alreadyRunning,
          sent: true,
          ...ids,
        };
      case 'runner_offline':
      case SKILLS_ERROR.commandUnavailable:
        return {
          status: 'failed',
          reason: SCHEDULE_FIRING_REASONS.runnerOffline,
          error,
          sent: false,
          ...ids,
        };
      // No answer in time: the runner may have started it; its events settle the run.
      case SKILLS_ERROR.runnerTimeout:
        if (body.runId) {
          return { status: 'started', sent: true, error, ...ids };
        }
        break;
    }
    this.logger.warn(`firing failed: ${body.code} ${body.message ?? ''}`);
    return {
      status: 'failed',
      reason: SCHEDULE_FIRING_REASONS.commandFailed,
      error,
      sent: Boolean(body.runId || body.commandRunId),
      ...ids,
    };
  }
}

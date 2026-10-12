import {
  type AdminScheduleView,
  type AuditAction,
  SCHEDULE_DETAIL_FIRINGS,
  SCHEDULE_PREVIEW_COUNT,
  SCHEDULES_ERROR,
  type ScheduleDetail,
  type ScheduleFiringView,
  type SchedulePreviewView,
  type ScheduleTarget,
  type ScheduleView,
} from '@agentdock/shared';
import { Injectable } from '@nestjs/common';
import type { Prisma, Schedule } from '@prisma/client';
import cronstrue from 'cronstrue';
import { AuditService } from '../audit/audit.service';
import type { AuditContext } from '../audit/audit.types';
import { PrismaService } from '../database/prisma.service';
import { projectNotFound } from '../projects';
import { CronError, CronSchedule } from './cron';
import type {
  AdminSchedulesQueryDto,
  ScheduleCreateDto,
  ScheduleUpdateDto,
} from './dto';
import { ScheduleFirer } from './schedule-firer';
import { ScheduleLive } from './schedule-live';
import { toFiringView, toScheduleView } from './schedule-mapper';
import { scheduleNotFound, schedulesError } from './schedules-error';
import { parseTarget } from './target';

/** Who calls a mutating route, as the route resolved them. */
export interface ScheduleCaller {
  userId: string;
  ctx: AuditContext;
}

const LAST_FIRING = {
  firings: { orderBy: { id: 'desc' }, take: 1 },
} satisfies Prisma.ScheduleInclude;

/** A cron error as the API answers it: 422 with its code. */
const parseCron = (cron: string, timezone: string, now = new Date()) => {
  try {
    return CronSchedule.parse(cron, timezone, now);
  } catch (error) {
    if (error instanceof CronError) {
      throw schedulesError(422, error.code, error.message);
    }
    throw error;
  }
};

/** The fields the audit log shows of a schedule. */
const auditable = (row: Schedule) => ({
  name: row.name,
  target: row.target,
  cron: row.cron,
  timezone: row.timezone,
  missedPolicy: row.missedPolicy,
  enabled: row.enabled,
});

/**
 * Schedules of a project (spec 25 "API"): create, edit, enable/disable,
 * delete and run now, each audited (D16); the preview of fire times; the
 * admin listing across projects.
 */
@Injectable()
export class SchedulesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly firer: ScheduleFirer,
    private readonly live: ScheduleLive,
  ) {}

  preview(cron: string, timezone: string): SchedulePreviewView {
    const now = new Date();
    const schedule = parseCron(cron, timezone, now);
    return {
      description: cronstrue.toString(schedule.expression, { verbose: false }),
      next: schedule
        .take(now, SCHEDULE_PREVIEW_COUNT)
        .map((d) => d.toISOString()),
    };
  }

  async list(projectId: string): Promise<ScheduleView[]> {
    const rows = await this.prisma.schedule.findMany({
      where: { projectId },
      include: LAST_FIRING,
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(({ firings, ...row }) =>
      toScheduleView(row, firings[0] ?? null),
    );
  }

  async detail(projectId: string, id: string): Promise<ScheduleDetail> {
    const row = await this.prisma.schedule.findFirst({
      where: { id, projectId },
      include: {
        firings: { orderBy: { id: 'desc' }, take: SCHEDULE_DETAIL_FIRINGS },
      },
    });
    if (!row) throw scheduleNotFound();
    const { firings, ...schedule } = row;
    return {
      ...toScheduleView(schedule, firings[0] ?? null),
      firings: firings.map(toFiringView),
    };
  }

  async adminList(query: AdminSchedulesQueryDto): Promise<AdminScheduleView[]> {
    const rows = await this.prisma.schedule.findMany({
      where: {
        ...(query.projectId ? { projectId: query.projectId } : {}),
        ...(query.enabled !== undefined ? { enabled: query.enabled } : {}),
      },
      include: { ...LAST_FIRING, project: { select: { displayName: true } } },
      orderBy: [{ projectId: 'asc' }, { createdAt: 'asc' }],
    });
    return rows.map(({ firings, project, ...row }) => ({
      ...toScheduleView(row, firings[0] ?? null),
      projectName: project.displayName,
    }));
  }

  async create(
    projectId: string,
    dto: ScheduleCreateDto,
    caller: ScheduleCaller,
  ): Promise<ScheduleView> {
    const schedule = parseCron(dto.cron, dto.timezone);
    const target = await this.validTarget(projectId, dto.target);
    const enabled = dto.enabled ?? true;
    const row = await this.prisma.schedule.create({
      data: {
        projectId,
        name: dto.name.trim(),
        target: target as unknown as Prisma.InputJsonObject,
        cron: dto.cron.trim(),
        timezone: dto.timezone,
        missedPolicy: dto.missedPolicy ?? 'skip',
        enabled,
        disabledReason: enabled ? null : 'manual',
        nextRunAt: enabled ? schedule.after(new Date()) : null,
        createdById: caller.userId,
      },
    });
    await this.record(
      caller,
      'schedule.create',
      row,
      undefined,
      auditable(row),
    );
    this.live.schedule(projectId, { id: row.id });
    return toScheduleView(row, null);
  }

  /**
   * Partial update. A new cron, timezone or enable recomputes `nextRunAt`;
   * re-enabling resets the failure counter. Field changes are
   * `schedule.update`; flipping `enabled` is `schedule.enable` / `.disable`.
   */
  async update(
    projectId: string,
    id: string,
    dto: ScheduleUpdateDto,
    caller: ScheduleCaller,
  ): Promise<ScheduleView> {
    const before = await this.find(projectId, id);
    const cron = dto.cron?.trim() ?? before.cron;
    const timezone = dto.timezone ?? before.timezone;
    const schedule = parseCron(cron, timezone);
    const target =
      dto.target !== undefined
        ? await this.validTarget(projectId, dto.target)
        : undefined;
    const enabled = dto.enabled ?? before.enabled;
    const enabling = enabled && !before.enabled;
    const disabling = !enabled && before.enabled;
    const timing =
      cron !== before.cron || timezone !== before.timezone || enabling;

    const data: Prisma.ScheduleUpdateInput = {
      ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
      ...(target
        ? { target: target as unknown as Prisma.InputJsonObject }
        : {}),
      cron,
      timezone,
      ...(dto.missedPolicy ? { missedPolicy: dto.missedPolicy } : {}),
      enabled,
      updatedBy: { connect: { id: caller.userId } },
      ...(enabling
        ? { disabledReason: null, consecutiveFailures: 0 }
        : disabling
          ? { disabledReason: 'manual', nextRunAt: null }
          : {}),
      ...(enabled && timing ? { nextRunAt: schedule.after(new Date()) } : {}),
    };
    const row = await this.prisma.schedule.update({ where: { id }, data });

    const fieldsChanged =
      dto.name !== undefined ||
      target !== undefined ||
      cron !== before.cron ||
      timezone !== before.timezone ||
      (dto.missedPolicy !== undefined &&
        dto.missedPolicy !== before.missedPolicy);
    if (fieldsChanged) {
      await this.record(
        caller,
        'schedule.update',
        row,
        auditable(before),
        auditable(row),
      );
    }
    if (enabling || disabling) {
      await this.record(
        caller,
        enabling ? 'schedule.enable' : 'schedule.disable',
        row,
        { enabled: before.enabled, disabledReason: before.disabledReason },
        { enabled: row.enabled, disabledReason: row.disabledReason },
      );
    }
    this.live.schedule(projectId, { id });
    const last = await this.prisma.scheduleFiring.findFirst({
      where: { scheduleId: id },
      orderBy: { id: 'desc' },
    });
    return toScheduleView(row, last);
  }

  /** Deletes the schedule and its firings; the runs they started stay (#21). */
  async remove(
    projectId: string,
    id: string,
    caller: ScheduleCaller,
  ): Promise<void> {
    const row = await this.find(projectId, id);
    await this.prisma.schedule.delete({ where: { id } });
    await this.record(
      caller,
      'schedule.delete',
      row,
      auditable(row),
      undefined,
    );
    this.live.schedule(projectId, { id, deleted: true });
  }

  /** D15: one occurrence now, as a `manual` firing; `nextRunAt` does not move. */
  async runNow(
    projectId: string,
    id: string,
    caller: ScheduleCaller,
  ): Promise<ScheduleFiringView> {
    const row = await this.find(projectId, id);
    const firing = await this.prisma.scheduleFiring.create({
      data: {
        scheduleId: id,
        scheduledFor: new Date(),
        kind: 'manual',
        status: 'due',
      },
    });
    await this.record(caller, 'schedule.run_now', row, undefined, {
      firingId: firing.id.toString(),
    });
    return toFiringView(await this.firer.fire(firing.id));
  }

  private async find(projectId: string, id: string): Promise<Schedule> {
    const row = await this.prisma.schedule.findFirst({
      where: { id, projectId },
    });
    if (!row) throw scheduleNotFound();
    return row;
  }

  /** D1: the union's shape, and a profile on this project's runner. */
  private async validTarget(
    projectId: string,
    raw: unknown,
  ): Promise<ScheduleTarget> {
    const target = parseTarget(raw);
    if (target.kind !== 'skill' || !target.profileId) return target;
    const [project, profile] = await Promise.all([
      this.prisma.project.findUnique({
        where: { id: projectId },
        select: { runnerId: true },
      }),
      this.prisma.runtimeProfile.findUnique({
        where: { id: target.profileId },
        select: { runnerId: true, runtime: true },
      }),
    ]);
    if (!project) throw projectNotFound();
    if (!profile || profile.runnerId !== project.runnerId) {
      throw schedulesError(
        422,
        SCHEDULES_ERROR.invalidTarget,
        "target.profileId is not a profile on this project's runner",
      );
    }
    if (profile.runtime !== 'claude') {
      throw schedulesError(
        422,
        SCHEDULES_ERROR.invalidTarget,
        'Skill runs need a claude profile',
      );
    }
    return target;
  }

  private record(
    caller: ScheduleCaller,
    action: AuditAction,
    row: Schedule,
    before: object | undefined,
    after: object | undefined,
  ) {
    return this.audit.record({
      ...caller.ctx,
      action,
      target: { type: 'schedule', id: row.id },
      projectId: row.projectId,
      ...(before ? { before } : {}),
      ...(after ? { after } : {}),
      result: 'ok',
    });
  }
}

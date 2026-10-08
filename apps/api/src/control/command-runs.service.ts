import {
  COMMAND_RUN_LIST_DEFAULT_LIMIT,
  COMMAND_RUN_LIVE_EVENT,
  type CommandRunCommand,
  type CommandRunLiveEvent,
  type CommandRunPage,
  type CommandRunStatus,
  type CommandRunView,
  type ControlErrorCode,
} from '@agentdock/shared';
import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { LiveService } from '../live/live.service';
import { controlError } from './control-error';

const RUN_SELECT = {
  id: true,
  projectId: true,
  command: true,
  slot: true,
  status: true,
  args: true,
  result: true,
  error: true,
  requestedAt: true,
  finishedAt: true,
  user: { select: { id: true, email: true } },
} satisfies Prisma.CommandRunSelect;

type RunRow = Prisma.CommandRunGetPayload<{ select: typeof RUN_SELECT }>;

const asRecord = (value: Prisma.JsonValue | null) =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

export const toCommandRunView = (row: RunRow): CommandRunView => ({
  id: row.id,
  projectId: row.projectId,
  command: row.command as CommandRunCommand,
  slot: row.slot,
  status: row.status,
  args: asRecord(row.args) ?? {},
  result: asRecord(row.result),
  error: asRecord(row.error) as CommandRunView['error'],
  user: row.user,
  requestedAt: row.requestedAt.toISOString(),
  finishedAt: row.finishedAt?.toISOString() ?? null,
});

export interface NewCommandRun {
  projectId: string;
  runnerId: string;
  userId: string | null;
  command: CommandRunCommand;
  slot?: string;
  args: object;
}

export type CommandRunEnd =
  | { status: 'ok'; result: object }
  | {
      status: Exclude<CommandRunStatus, 'ok' | 'requested'>;
      error: { code: ControlErrorCode; message: string };
    };

/**
 * The `command_runs` log (spec 17 D10): a row per control command, created
 * `requested` before it is sent and finished once with its outcome. Every
 * change is published on `project:<id>` as `command_run.updated`.
 */
@Injectable()
export class CommandRunsService {
  private readonly logger = new Logger(CommandRunsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly live: LiveService,
  ) {}

  async create(run: NewCommandRun): Promise<CommandRunView> {
    const row = await this.prisma.commandRun.create({
      data: {
        projectId: run.projectId,
        runnerId: run.runnerId,
        userId: run.userId,
        command: run.command,
        slot: run.slot ?? null,
        args: run.args as Prisma.InputJsonObject,
      },
      select: RUN_SELECT,
    });
    return this.publish(toCommandRunView(row));
  }

  async finish(id: string, end: CommandRunEnd): Promise<CommandRunView> {
    const row = await this.prisma.commandRun.update({
      where: { id },
      data: {
        status: end.status,
        finishedAt: new Date(),
        ...(end.status === 'ok'
          ? { result: end.result as Prisma.InputJsonObject }
          : { error: end.error }),
      },
      select: RUN_SELECT,
    });
    return this.publish(toCommandRunView(row));
  }

  /** Newest first; `cursor` is the last id of the previous page. */
  async list(
    projectId: string,
    query: { limit?: number; cursor?: string },
  ): Promise<CommandRunPage> {
    const limit = query.limit ?? COMMAND_RUN_LIST_DEFAULT_LIMIT;
    if (query.cursor) {
      const cursor = await this.prisma.commandRun.findFirst({
        where: { id: query.cursor, projectId },
        select: { id: true },
      });
      if (!cursor) {
        throw controlError(400, 'invalid_args', 'Unknown cursor');
      }
    }
    const rows = await this.prisma.commandRun.findMany({
      where: { projectId },
      orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      select: RUN_SELECT,
    });
    const page = rows.slice(0, limit);
    return {
      items: page.map(toCommandRunView),
      nextCursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
    };
  }

  /** Best effort, like every live update: a failed publish never fails the action. */
  private publish(view: CommandRunView): CommandRunView {
    const { args: _args, ...event } = view;
    try {
      this.live.publish(
        `project:${view.projectId}`,
        COMMAND_RUN_LIVE_EVENT,
        event satisfies CommandRunLiveEvent,
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `command_run.updated ${view.id} not published: ${reason}`,
      );
    }
    return view;
  }
}

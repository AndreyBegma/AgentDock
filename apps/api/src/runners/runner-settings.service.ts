import { type LocalRunner, RUNNER_ERROR } from '@nautelle/shared';
import { HttpException, Injectable, Logger } from '@nestjs/common';
import type { Runner } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import type { AuditContext } from '../audit/audit.types';
import { PrismaService } from '../database/prisma.service';
import { runnerError } from './runner-error';
import { toLocalRunner } from './runner-mapper';
import { RunnerReleaseService } from './runner-release.service';
import { RunnerWatchList } from './runner-watch-list';

/** What spec 201 adds to a runner's settings (D8, D17). */
export interface RunnerLocalSettings {
  /** The user a local request acts as; null refuses every local request. */
  localUserId: string | null;
  awayMode: boolean;
}

export interface RunnerSettingsPatch {
  localUserId?: string | null;
  awayMode?: boolean;
}

/** Who changes them: a person, or a local request acting for one (`away.set`). */
export interface RunnerSettingsActor {
  userId: string;
  isAdmin: boolean;
  ctx: AuditContext;
  /** Merged into the audit record's `meta` — `via`, `onBehalfOf`. */
  meta?: object;
}

/**
 * A runner a user is the local user of — what they may set away mode on, and
 * whether it is older than the latest release (C-328).
 */
export type LocalRunnerView = LocalRunner;

const invalidUser = () => {
  const body = {
    statusCode: 422,
    error: 'invalid_args',
    message: 'localUserId must be the id of an active user',
  };
  return new HttpException(body, 422);
};

/**
 * The runner's local user and away mode (spec 201 D8, D17). The local user is
 * an admin's choice; away mode is the admin's or the local user's own. Every
 * change is audited as `runner.update`, and a change of away mode is pushed to
 * the runner in `config` at once.
 */
@Injectable()
export class RunnerSettingsService {
  private readonly logger = new Logger(RunnerSettingsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly watchList: RunnerWatchList,
    private readonly release: RunnerReleaseService,
  ) {}

  async update(
    id: string,
    patch: RunnerSettingsPatch,
    actor: RunnerSettingsActor,
  ): Promise<Runner> {
    const before = await this.prisma.runner.findUnique({ where: { id } });
    // Someone who is neither an admin nor its local user does not see it —
    // checked before the field permission so a 403 never confirms an id.
    if (!before || (!actor.isAdmin && before.localUserId !== actor.userId)) {
      throw runnerError(404, RUNNER_ERROR.notFound, 'Runner not found');
    }
    if (patch.localUserId !== undefined && !actor.isAdmin) {
      throw runnerError(
        403,
        RUNNER_ERROR.forbidden,
        "Only an admin changes a runner's local user",
      );
    }
    if (patch.localUserId) {
      const user = await this.prisma.user.findUnique({
        where: { id: patch.localUserId },
        select: { status: true },
      });
      if (user?.status !== 'active') throw invalidUser();
    }

    const data: RunnerSettingsPatch = {};
    if (
      patch.localUserId !== undefined &&
      patch.localUserId !== before.localUserId
    ) {
      data.localUserId = patch.localUserId;
    }
    if (patch.awayMode !== undefined && patch.awayMode !== before.awayMode) {
      data.awayMode = patch.awayMode;
    }
    if (Object.keys(data).length === 0) return before;

    const runner = await this.prisma.runner.update({ where: { id }, data });
    await this.audit.record({
      ...actor.ctx,
      action: 'runner.update',
      target: { type: 'runner', id },
      before: Object.fromEntries(
        Object.keys(data).map((k) => [k, before[k as keyof typeof data]]),
      ),
      after: data,
      result: 'ok',
      ...(actor.meta ? { meta: actor.meta } : {}),
    });
    if (data.awayMode !== undefined) {
      await this.watchList.push(id).catch((error: unknown) => {
        // The runner picks it up at its next `welcome`.
        this.logger.warn(
          `runner ${id}: away mode not pushed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    }
    return runner;
  }

  /** The runners `userId` is the local user of, oldest first. */
  async localRunners(userId: string): Promise<LocalRunnerView[]> {
    const runners = await this.prisma.runner.findMany({
      where: { localUserId: userId, revokedAt: null },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        name: true,
        localUserId: true,
        awayMode: true,
        hostname: true,
        version: true,
      },
    });
    return runners.map((runner) => this.toView(runner));
  }

  /** The runner as its local user sees it, with the version check (C-328). */
  toView(runner: Parameters<typeof toLocalRunner>[0]): LocalRunnerView {
    return toLocalRunner(runner, this.release.latest);
  }
}

import { parseUiProfileOutput } from '@nautelle/shared';
import {
  isUiProfileBuildEventType,
  type RunnerEvent,
  type UiProfileBuildFinishedData,
  type UiProfileBuildPhaseChangedData,
  uiProfileBuildEventDataSchemas,
} from '@nautelle/shared/protocol';
import {
  HttpException,
  Injectable,
  Logger,
  type OnModuleInit,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { SYSTEM_ACTOR, systemActorFor } from '../audit/audit.types';
import { PrismaService } from '../database/prisma.service';
import { PlanStore } from '../planner/plan-store';
import {
  type RunnerEventSink,
  RunnerEventSinks,
} from '../runners/runner-event-sinks';
import { DesignService } from './design.service';
import { currentProfile } from './design-store';
import { settleBuildRun, UiProfileService } from './ui-profile.service';
import { buildArgsOf, memoryOf } from './ui-profile-mapper';

/**
 * Applies `uiprofile_build.*` (docs/specs/223-design-stage.md D12–D14). The
 * runner returns text; the API validates it with `parseUiProfileOutput`,
 * fingerprints the files the profile names, and writes the next version.
 * A violation fails the run `contract_violation` and writes nothing. A run
 * is touched only by the runner of its project, and `finished` lands once.
 * The designs waiting for the build start their turns, or rest.
 */
@Injectable()
export class UiProfileProjector implements RunnerEventSink, OnModuleInit {
  readonly name = 'ui-profile';
  private readonly logger = new Logger(UiProfileProjector.name);

  constructor(
    private readonly sinks: RunnerEventSinks,
    private readonly prisma: PrismaService,
    private readonly store: PlanStore,
    private readonly profiles: UiProfileService,
    private readonly designs: DesignService,
    private readonly audit: AuditService,
  ) {}

  onModuleInit(): void {
    this.sinks.register(this);
  }

  async handle(runnerId: string, events: RunnerEvent[]): Promise<void> {
    for (const event of events) {
      if (!isUiProfileBuildEventType(event.type)) continue;
      const parsed = uiProfileBuildEventDataSchemas[event.type].safeParse(
        event.data,
      );
      if (!parsed.success) {
        this.logger.warn(
          `runner ${runnerId}: malformed ${event.type} (seq ${event.seq}), skipped`,
        );
        continue;
      }
      if (event.type === 'uiprofile_build.phase_changed') {
        const data = parsed.data as UiProfileBuildPhaseChangedData;
        const run = await this.runOf(runnerId, data);
        if (run) await this.store.publishRun(run.projectId, run.id);
      } else {
        await this.finished(
          runnerId,
          parsed.data as UiProfileBuildFinishedData,
        );
      }
    }
  }

  /** The build run, if it is that project's, on this runner, and still running. */
  private async runOf(
    runnerId: string,
    data: { runId: string; projectId: string },
  ) {
    const run = await this.prisma.run.findFirst({
      where: {
        id: data.runId,
        projectId: data.projectId,
        kind: 'ui_profile',
        project: { runnerId },
      },
      select: {
        id: true,
        projectId: true,
        status: true,
        args: true,
        triggeredById: true,
      },
    });
    if (!run) {
      this.logger.warn(
        `runner ${runnerId}: profile build ${data.runId} of project ${data.projectId} not found, skipped`,
      );
    }
    return run;
  }

  private async finished(
    runnerId: string,
    data: UiProfileBuildFinishedData,
  ): Promise<void> {
    const run = await this.runOf(runnerId, data);
    if (!run || run.status !== 'running') return;
    const args = buildArgsOf(run.args);
    const waiting = args?.waiting ?? [];
    const at = new Date(data.at);

    const fail = async (phase: 'failed' | 'cancelled', why: string) => {
      const settled = await settleBuildRun(this.prisma, run.id, phase, why, at);
      if (!settled) return;
      await this.store.publishRun(run.projectId, run.id);
      await this.designs.afterBuild(waiting, undefined);
    };

    if (data.phase !== 'succeeded') {
      await fail(data.phase, data.error ?? `the build ended ${data.phase}`);
      return;
    }
    if (data.resultTruncated) {
      await fail(
        'failed',
        'contract_violation: result_truncated: the result was cut at the event size limit',
      );
      return;
    }
    const parsed = parseUiProfileOutput(data.resultText ?? '');
    if (!parsed.ok) {
      await fail(
        'failed',
        `contract_violation: ${parsed.error.reason}: ${parsed.error.message}`,
      );
      return;
    }
    const output = parsed.output;
    const fingerprint = await this.fingerprint(
      run.projectId,
      output.fingerprintGlobs,
      run.triggeredById,
    );

    const created = await this.prisma.$transaction(async (tx) => {
      const settled = await settleBuildRun(tx, run.id, 'succeeded', null, at);
      if (!settled) return null;
      await tx.$queryRaw`SELECT id FROM projects WHERE id = ${run.projectId} FOR UPDATE`;
      const current = await currentProfile(tx, run.projectId);
      return tx.uiProfile.create({
        data: {
          projectId: run.projectId,
          version: (current?.version ?? 0) + 1,
          source: 'agent',
          hasUi: output.hasUi,
          summary: output.summary,
          kit: output.kit,
          snippets: output.snippets as Prisma.InputJsonValue,
          fingerprintGlobs: output.fingerprintGlobs,
          fingerprint,
          obligations: args?.obligations ?? null,
          runId: run.id,
          // #752 A4: the library and style rules ride on every later version.
          ...memoryOf(current),
        },
        select: { id: true, version: true },
      });
    });
    if (!created) return;
    await this.audit.record({
      actor: run.triggeredById
        ? systemActorFor(run.triggeredById)
        : SYSTEM_ACTOR,
      action: 'uiprofile.built',
      target: { type: 'ui_profile', id: created.id },
      projectId: run.projectId,
      after: {
        version: created.version,
        hasUi: output.hasUi,
        runId: run.id,
        reason: args?.reason ?? null,
        obligations:
          args?.obligations !== null && args?.obligations !== undefined,
      },
      result: 'ok',
    });
    await this.store.publishRun(run.projectId, run.id);
    await this.designs.afterBuild(waiting, created.id, run.id);
  }

  /**
   * D13: the new version's fingerprint, over the files it names. With no
   * globs there is nothing to watch; when the runner cannot answer, the
   * version is stored without one and the next check adopts its hash.
   */
  private async fingerprint(
    projectId: string,
    globs: string[],
    userId: string | null,
  ): Promise<string> {
    if (globs.length === 0) return '';
    try {
      const project = await this.store.project(projectId);
      return await this.profiles.fingerprint(project, globs, {
        role: 'operator',
        ctx: { actor: userId ? systemActorFor(userId) : SYSTEM_ACTOR },
      });
    } catch (error) {
      if (!(error instanceof HttpException)) throw error;
      this.logger.warn(
        `project ${projectId}: fingerprint after a build failed: ${(error as Error).message}`,
      );
      return '';
    }
  }
}

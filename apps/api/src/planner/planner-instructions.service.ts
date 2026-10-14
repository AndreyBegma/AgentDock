import {
  PLANNER_CONTRACT_VERSION,
  PLANNER_ERROR,
  PLANNER_OUTPUT_CONTRACT,
  type PlannerInstructionsVersion,
  type PlannerInstructionsView,
  type PlannerSettingsUpdateRequest,
  type PlannerSettingsView,
  type PlannerSpecOutput,
} from '@agentdock/shared';
import { repoRelativeDirSchema } from '@agentdock/shared/protocol';
import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import type { AuditContext } from '../audit/audit.types';
import { PrismaService } from '../database/prisma.service';
import { projectNotFound } from '../projects';
import { toInstructionsVersion, versionInclude } from './plan-mapper';
import { plannerError } from './planner-error';

/**
 * The project's `specDir` (#10, `orchestrator.specDir`) when `plan.publish_specs`
 * can write to it: a repository-relative directory. A path outside the
 * repository (`../x-documentation/prs`) or a URL is not one (spec 172 Q4).
 */
export const specDirOf = (config: Prisma.JsonValue): string | null => {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return null;
  }
  const orchestrator = config.orchestrator;
  if (
    !orchestrator ||
    typeof orchestrator !== 'object' ||
    Array.isArray(orchestrator)
  ) {
    return null;
  }
  const parsed = repoRelativeDirSchema.safeParse(orchestrator.specDir);
  return parsed.success ? parsed.data : null;
};

/** D10: the mode a project without a settings row gets. */
export const defaultSpecOutput = (specDir: string | null): PlannerSpecOutput =>
  specDir ? 'docs_pr' : 'issue_body';

/**
 * The planner's instructions and per-project settings (D10, D11, ADR-0019).
 * Every save is a new version; a plan records the version it ran with. The
 * global default is a site admin's; a project override is the project
 * admin's, and clearing it keeps its versions listed.
 */
@Injectable()
export class PlannerInstructionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async global(): Promise<PlannerInstructionsView> {
    const versions = await this.versions(null);
    const current = versions[0];
    if (!current) throw noGlobalInstructions();
    return {
      current,
      versions,
      contract: PLANNER_OUTPUT_CONTRACT,
      contractVersion: PLANNER_CONTRACT_VERSION,
    };
  }

  async updateGlobal(
    ctx: AuditContext,
    authorId: string,
    body: string,
  ): Promise<PlannerInstructionsView> {
    const row = await this.prisma.$transaction((tx) =>
      this.nextVersion(tx, null, authorId, body),
    );
    await this.audit.record({
      ...ctx,
      action: 'planner.instructions_updated',
      target: { type: 'planner_instructions', id: row.id },
      after: { scope: 'global', version: row.version },
      result: 'ok',
    });
    return this.global();
  }

  async settings(projectId: string): Promise<PlannerSettingsView> {
    const [project, settings, overrideVersions] = await Promise.all([
      this.project(projectId),
      this.prisma.plannerSettings.findUnique({
        where: { projectId },
        include: { overrideInstructions: { include: versionInclude } },
      }),
      this.versions(projectId),
    ]);
    return {
      specOutput:
        settings?.specOutput ??
        defaultSpecOutput(specDirOf(project.codeSentinelConfig)),
      override: settings?.overrideInstructions
        ? toInstructionsVersion(settings.overrideInstructions)
        : null,
      overrideVersions,
      contract: PLANNER_OUTPUT_CONTRACT,
      contractVersion: PLANNER_CONTRACT_VERSION,
    };
  }

  /**
   * `specOutput` is always written. `instructionsOverride`: absent keeps the
   * override, blank clears it, text writes a new project version and points
   * at it. `docs_pr` needs a repository-relative `specDir` (Q4).
   */
  async updateSettings(
    ctx: AuditContext,
    userId: string,
    projectId: string,
    request: PlannerSettingsUpdateRequest,
  ): Promise<PlannerSettingsView> {
    const project = await this.project(projectId);
    if (
      request.specOutput === 'docs_pr' &&
      !specDirOf(project.codeSentinelConfig)
    ) {
      throw plannerError(
        422,
        PLANNER_ERROR.invalidArgs,
        'docs_pr needs the project to have a specDir inside the repository',
      );
    }
    const before = await this.prisma.plannerSettings.findUnique({
      where: { projectId },
      select: { specOutput: true, overrideInstructionsId: true },
    });
    const override = request.instructionsOverride;
    const written = await this.prisma.$transaction(async (tx) => {
      let overrideInstructionsId = before?.overrideInstructionsId ?? null;
      let version: number | null = null;
      if (override !== undefined) {
        if (override.trim() === '') {
          overrideInstructionsId = null;
        } else {
          const row = await this.nextVersion(tx, projectId, userId, override);
          overrideInstructionsId = row.id;
          version = row.version;
        }
      }
      await tx.plannerSettings.upsert({
        where: { projectId },
        create: {
          projectId,
          specOutput: request.specOutput,
          overrideInstructionsId,
          updatedById: userId,
        },
        update: {
          specOutput: request.specOutput,
          overrideInstructionsId,
          updatedById: userId,
        },
      });
      return { overrideInstructionsId, version };
    });
    await this.audit.record({
      ...ctx,
      action: 'planner.settings_updated',
      target: { type: 'project', id: projectId },
      projectId,
      before: before ?? {},
      after: {
        specOutput: request.specOutput,
        overrideInstructionsId: written.overrideInstructionsId,
        ...(written.version !== null
          ? { overrideVersion: written.version }
          : {}),
      },
      result: 'ok',
    });
    return this.settings(projectId);
  }

  /** The instructions a new plan of the project runs with: its override, else the latest global. */
  async effective(projectId: string): Promise<{ id: string; body: string }> {
    const settings = await this.prisma.plannerSettings.findUnique({
      where: { projectId },
      select: { overrideInstructions: { select: { id: true, body: true } } },
    });
    if (settings?.overrideInstructions) return settings.overrideInstructions;
    const global = await this.prisma.plannerInstructions.findFirst({
      where: { projectId: null },
      orderBy: { version: 'desc' },
      select: { id: true, body: true },
    });
    if (!global) throw noGlobalInstructions();
    return global;
  }

  private async versions(
    projectId: string | null,
  ): Promise<PlannerInstructionsVersion[]> {
    const rows = await this.prisma.plannerInstructions.findMany({
      where: { projectId },
      orderBy: { version: 'desc' },
      include: versionInclude,
    });
    return rows.map(toInstructionsVersion);
  }

  private async nextVersion(
    tx: Prisma.TransactionClient,
    projectId: string | null,
    authorId: string,
    body: string,
  ) {
    const last = await tx.plannerInstructions.findFirst({
      where: { projectId },
      orderBy: { version: 'desc' },
      select: { version: true },
    });
    return tx.plannerInstructions.create({
      data: {
        projectId,
        version: (last?.version ?? 0) + 1,
        body,
        authorId,
      },
      select: { id: true, version: true },
    });
  }

  private async project(projectId: string) {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { codeSentinelConfig: true },
    });
    if (!project) throw projectNotFound();
    return project;
  }
}

/** The seed writes global version 1; without it the planner cannot run. */
const noGlobalInstructions = () =>
  plannerError(
    503,
    PLANNER_ERROR.commandUnavailable,
    'No global planner instructions: run the database seed',
  );

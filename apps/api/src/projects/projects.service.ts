import {
  type DocsSourceOverrideRequest,
  effectiveProjectRole,
  type ProjectDetail,
  type ProjectSummary,
  type Role,
} from '@agentdock/shared';
import type { ProjectInspection } from '@agentdock/shared/protocol';
import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import type { AuditContext } from '../audit/audit.types';
import type { AuthUser } from '../auth';
import { PrismaService } from '../database/prisma.service';
import { RunnerPresence } from '../runners/runner-presence';
import { RunnerWatchList } from '../runners/runner-watch-list';
import type { UpdateProjectDto } from './dto';
import { ProjectAccessService } from './project-access.service';
import { projectError, projectNotFound } from './project-error';
import { ProjectInspector } from './project-inspector';
import {
  detectedDocsData,
  EMPTY_CLASSIFIED,
  type ProjectWithRelations,
  toProjectDetail,
  toProjectSummary,
} from './project-mapper';

const withRelations = {
  runner: { select: { id: true, name: true, revokedAt: true } },
  docsSource: true,
} as const;

const isUniqueViolation = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError &&
  error.code === 'P2002';

/** The columns an inspection sets on a project, at connect and on refresh. */
const inspectionData = (inspection: ProjectInspection) => ({
  baseBranch: inspection.baseBranch,
  baseSource: inspection.baseSource,
  codeSentinelConfig: inspection.codeSentinelConfig as Prisma.InputJsonValue,
  hasClaudeMd: inspection.hasClaudeMd,
  hasAgentsMd: inspection.hasAgentsMd,
  lastInspectedAt: new Date(),
});

/** Spec 10 "API": connect, delete, read, settings, refresh, docs source. */
@Injectable()
export class ProjectsService {
  private readonly logger = new Logger(ProjectsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ProjectAccessService,
    private readonly inspector: ProjectInspector,
    private readonly presence: RunnerPresence,
    private readonly watchList: RunnerWatchList,
    private readonly audit: AuditService,
  ) {}

  /** D1: a preview, no write. */
  async inspect(
    runnerId: string,
    path: string,
    ctx: AuditContext,
  ): Promise<ProjectInspection> {
    await this.usableRunner(runnerId);
    return this.inspector.inspect(runnerId, path, ctx);
  }

  /** D1–D3, D9, D14: re-inspects, stores, and pushes the watch list. */
  async connect(
    runnerId: string,
    path: string,
    displayName: string | undefined,
    adminId: string,
    ctx: AuditContext,
  ): Promise<ProjectDetail> {
    await this.usableRunner(runnerId);
    const inspection = await this.inspector.inspect(runnerId, path, ctx);
    if (!inspection.isMainCheckout) {
      throw projectError(
        409,
        'not_main_checkout',
        `Not the main checkout; connect ${inspection.root} instead`,
        { suggestedPath: inspection.root },
      );
    }
    const repo = inspection.remote.repo;
    if (inspection.remote.forge !== 'github' || repo === null) {
      throw projectError(
        422,
        'unsupported_forge',
        inspection.remote.url
          ? `origin is not on GitHub: ${inspection.remote.url}`
          : 'The repository has no origin on GitHub',
      );
    }

    let project: ProjectWithRelations;
    try {
      project = await this.prisma.project.create({
        data: {
          runnerId,
          rootPath: inspection.root,
          repo,
          displayName: displayName ?? repo.slice(repo.indexOf('/') + 1),
          ...inspectionData(inspection),
          createdById: adminId,
          docsSource: { create: detectedDocsData(inspection.docs) },
        },
        include: withRelations,
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw projectError(
          409,
          'already_connected',
          `This runner already has a project at ${inspection.root}`,
        );
      }
      throw error;
    }
    this.logger.log(`project ${project.id} connected (${repo})`);
    await this.audit.record({
      ...ctx,
      action: 'project.connect',
      target: { type: 'project', id: project.id },
      projectId: project.id,
      after: {
        runnerId,
        rootPath: project.rootPath,
        repo,
        displayName: project.displayName,
        docsKind: inspection.docs.kind,
      },
      result: 'ok',
    });
    await this.watchList.push(runnerId);
    return this.toDetail(project, 'admin');
  }

  /** D15: rows only — the disk is never touched. */
  async remove(projectId: string, ctx: AuditContext): Promise<void> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
    });
    if (!project) throw projectNotFound();
    try {
      await this.prisma.project.delete({ where: { id: projectId } });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2025'
      ) {
        throw projectNotFound();
      }
      throw error;
    }
    this.logger.log(`project ${projectId} deleted`);
    await this.audit.record({
      ...ctx,
      action: 'project.delete',
      target: { type: 'project', id: projectId },
      projectId,
      before: {
        runnerId: project.runnerId,
        rootPath: project.rootPath,
        repo: project.repo,
        displayName: project.displayName,
      },
      result: 'ok',
    });
    await this.watchList.push(project.runnerId);
  }

  /** D11: admins see every project; others their memberships. */
  async list(user: AuthUser): Promise<ProjectSummary[]> {
    const projects = await this.prisma.project.findMany({
      where: this.access.visibleWhere(user),
      orderBy: [{ displayName: 'asc' }, { createdAt: 'asc' }],
      include: {
        ...withRelations,
        members: { where: { userId: user.id }, select: { roleOverride: true } },
      },
    });
    return projects.map((project) =>
      toProjectSummary(
        project,
        this.presence.status(project.runner),
        user.role === 'admin'
          ? 'admin'
          : effectiveProjectRole(
              user.role,
              project.members[0]?.roleOverride ?? null,
            ),
      ),
    );
  }

  async detail(projectId: string, role: Role): Promise<ProjectDetail> {
    return this.toDetail(await this.load(projectId), role);
  }

  /** D13. `defaultProfileId` must be a profile of the project's runner. */
  async update(
    projectId: string,
    dto: UpdateProjectDto,
    ctx: AuditContext,
  ): Promise<ProjectDetail> {
    const project = await this.load(projectId);
    if (dto.defaultProfileId) {
      const profile = await this.prisma.runtimeProfile.findUnique({
        where: { id: dto.defaultProfileId },
        select: { runnerId: true },
      });
      if (profile?.runnerId !== project.runnerId) {
        throw projectError(
          422,
          'profile_not_on_runner',
          "defaultProfileId is not a profile of the project's runner",
        );
      }
    }
    const fields = [
      'displayName',
      'baseOverride',
      'readyLabelOverride',
      'defaultProfileId',
      'mergeApproval',
    ] as const;
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    const data: Prisma.ProjectUncheckedUpdateInput = {};
    for (const field of fields) {
      const value = dto[field];
      if (value === undefined || value === project[field]) continue;
      before[field] = project[field];
      after[field] = value;
      Object.assign(data, { [field]: value });
    }
    if (Object.keys(after).length === 0) return this.toDetail(project, 'admin');

    const updated = await this.prisma.project.update({
      where: { id: projectId },
      data,
      include: withRelations,
    });
    await this.audit.record({
      ...ctx,
      action: 'project.update',
      target: { type: 'project', id: projectId },
      projectId,
      before,
      after,
      result: 'ok',
    });
    return this.toDetail(updated, 'admin');
  }

  /** D9: re-inspects the root; a manual docs source is kept. */
  async refresh(
    projectId: string,
    role: Role,
    ctx: AuditContext,
  ): Promise<ProjectDetail> {
    const project = await this.load(projectId);
    const inspection = await this.inspector.refresh(project, role, ctx);
    const keepDocs = project.docsSource?.manual === true;
    const docs = detectedDocsData(inspection.docs);
    const updated = await this.prisma.project.update({
      where: { id: projectId },
      data: {
        ...inspectionData(inspection),
        // A repository whose origin went away keeps the repo it connected with.
        ...(inspection.remote.repo ? { repo: inspection.remote.repo } : {}),
        ...(keepDocs
          ? {}
          : { docsSource: { upsert: { create: docs, update: docs } } }),
      },
      include: withRelations,
    });
    return this.toDetail(updated, role);
  }

  /** Manual override: no disk is read, the admin's word is stored. */
  async overrideDocsSource(
    projectId: string,
    request: DocsSourceOverrideRequest,
    ctx: AuditContext,
  ): Promise<ProjectDetail> {
    const project = await this.load(projectId);
    const data = manualDocsData(project.rootPath, request);
    const updated = await this.prisma.project.update({
      where: { id: projectId },
      data: { docsSource: { upsert: { create: data, update: data } } },
      include: withRelations,
    });
    await this.audit.record({
      ...ctx,
      action: 'project.docs_source_override',
      target: { type: 'project', id: projectId },
      projectId,
      before: project.docsSource ? docsSummary(project.docsSource) : {},
      after: docsSummary(data),
      result: 'ok',
    });
    return this.toDetail(updated, 'admin');
  }

  /** Restores detection: re-inspects on the runner (admin) and stores its result. */
  async resetDocsSource(
    projectId: string,
    ctx: AuditContext,
  ): Promise<ProjectDetail> {
    const project = await this.load(projectId);
    const inspection = await this.inspector.refresh(project, 'admin', ctx);
    const docs = detectedDocsData(inspection.docs);
    const updated = await this.prisma.project.update({
      where: { id: projectId },
      data: {
        ...inspectionData(inspection),
        ...(inspection.remote.repo ? { repo: inspection.remote.repo } : {}),
        docsSource: { upsert: { create: docs, update: docs } },
      },
      include: withRelations,
    });
    await this.audit.record({
      ...ctx,
      action: 'project.docs_source_reset',
      target: { type: 'project', id: projectId },
      projectId,
      before: project.docsSource ? docsSummary(project.docsSource) : {},
      after: docsSummary(docs),
      result: 'ok',
    });
    return this.toDetail(updated, 'admin');
  }

  private async load(projectId: string): Promise<ProjectWithRelations> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      include: withRelations,
    });
    if (!project) throw projectNotFound();
    return project;
  }

  private toDetail(project: ProjectWithRelations, role: Role): ProjectDetail {
    return toProjectDetail(project, this.presence.status(project.runner), role);
  }

  private async usableRunner(runnerId: string): Promise<void> {
    const runner = await this.prisma.runner.findUnique({
      where: { id: runnerId },
      select: { revokedAt: true },
    });
    if (!runner) throw projectError(404, 'not_found', 'Runner not found');
    if (runner.revokedAt) {
      throw projectError(409, 'runner_offline', 'The runner is revoked');
    }
  }
}

const docsSummary = (docs: {
  kind: string;
  localPath: string | null;
  repo: string | null;
  manual: boolean;
}) => ({
  kind: docs.kind,
  localPath: docs.localPath,
  repo: docs.repo,
  manual: docs.manual,
});

const invalid = (message: string) =>
  projectError(422, 'invalid_docs_source', message);

/**
 * The `docs_sources` columns for an admin's override. The API reads no disk
 * (ADR-0001), so `isGitRepo` follows from what the admin stated.
 */
export const manualDocsData = (
  rootPath: string,
  { kind, localPath, repo }: DocsSourceOverrideRequest,
) => {
  switch (kind) {
    case 'in_repo':
      if (!localPath || repo) {
        throw invalid('in_repo takes a localPath and no repo');
      }
      if (localPath !== rootPath && !localPath.startsWith(`${rootPath}/`)) {
        throw invalid('An in_repo localPath must be under the project root');
      }
      break;
    case 'sibling_repo':
      if (!localPath) throw invalid('sibling_repo takes a localPath');
      break;
    case 'remote_repo':
      if (!repo || localPath) {
        throw invalid('remote_repo takes a repo and no localPath');
      }
      break;
    case 'none':
      if (localPath || repo) throw invalid('none takes no localPath or repo');
      break;
  }
  const isGitRepo =
    kind === 'in_repo' ||
    kind === 'remote_repo' ||
    (kind === 'sibling_repo' && Boolean(repo));
  return {
    kind,
    localPath: localPath ?? null,
    repo: repo ?? null,
    isGitRepo,
    detectedBy: null,
    evidence: [],
    classified: EMPTY_CLASSIFIED,
    candidates: [],
    manual: true,
  };
};

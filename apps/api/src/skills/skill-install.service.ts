import {
  type AuditResult,
  type CommandRunView,
  effectiveProjectRole,
  projectRoleAtLeast,
  type Role,
  SKILL_PREVIEW_TTL_MS,
  SKILLS_ERROR,
  type SkillCatalogView,
  type SkillInspectView,
  type SkillProfileInstallView,
} from '@agentdock/shared';
import {
  profileKeySchema,
  type Runtime,
  roleAtLeast,
  type SkillInstallArgs,
  skillInstallMinRole,
  skillNameSchema,
} from '@agentdock/shared/protocol';
import { Injectable, Logger } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import type { AuditContext } from '../audit/audit.types';
import type { AuthUser } from '../auth';
import { CommandRunsService } from '../control/command-runs.service';
import { PrismaService } from '../database/prisma.service';
import { ProjectAccessService } from '../projects';
import type { SkillInspectDto, SkillInstallDto } from './dto';
import { SkillCommands, skillOutput } from './skill-commands';
import {
  SkillInventoryService,
  type SkillProject,
} from './skill-inventory.service';
import { asJson, type PreviewPayload, toPreviewView } from './skill-mapper';
import { SkillsFailure, skillsError } from './skills-error';

/** A signed-in caller of a skills route. */
export interface SkillCaller {
  user: Pick<AuthUser, 'id' | 'role'>;
  ctx: AuditContext;
}

/** A caller of a project route, with their effective project role. */
export interface ProjectSkillCaller extends SkillCaller {
  projectId: string;
  role: Role;
}

const runnerNotFound = () =>
  skillsError(404, SKILLS_ERROR.notFound, 'Runner not found');

/**
 * Catalog search, inspect and install (spec 24 D1–D5, D14). Registry access
 * and every write happen on the runner; the API keeps the previews, checks
 * roles and audits.
 */
@Injectable()
export class SkillInstallService {
  private readonly logger = new Logger(SkillInstallService.name);
  /** Project installs still running on the runner (tests await them). */
  private readonly pending = new Set<Promise<void>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly commands: SkillCommands,
    private readonly inventory: SkillInventoryService,
    private readonly access: ProjectAccessService,
    private readonly runs: CommandRunsService,
    private readonly audit: AuditService,
  ) {}

  /** Resolves once every background install started so far has finished. */
  async settled(): Promise<void> {
    await Promise.all([...this.pending]);
  }

  /**
   * The caller's role on a runner, for catalog and inspect (spec "API"): an
   * admin, or the best role over the runner's projects the caller is a member
   * of. A runner none of whose projects the caller can see is 404.
   */
  async runnerRole(
    user: Pick<AuthUser, 'id' | 'role'>,
    runnerId: string,
  ): Promise<Role> {
    if (user.role === 'admin') {
      const runner = await this.prisma.runner.findUnique({
        where: { id: runnerId },
        select: { id: true },
      });
      if (!runner) throw runnerNotFound();
      return 'admin';
    }
    const memberships = await this.prisma.projectMember.findMany({
      where: { userId: user.id, project: { runnerId } },
      select: { roleOverride: true },
    });
    if (memberships.length === 0) throw runnerNotFound();
    return memberships
      .map((m) => effectiveProjectRole(user.role, m.roleOverride))
      .reduce((best, r) => (roleAtLeast(r, best) ? r : best));
  }

  private async operatorOnRunner(
    caller: SkillCaller,
    runnerId: string,
  ): Promise<Role> {
    const role = await this.runnerRole(caller.user, runnerId);
    if (!projectRoleAtLeast(role, 'operator')) {
      throw skillsError(
        403,
        SKILLS_ERROR.forbidden,
        'This needs the operator role on a project of this runner',
      );
    }
    return role;
  }

  async catalog(
    caller: SkillCaller,
    runnerId: string,
    query: string,
  ): Promise<SkillCatalogView> {
    const role = await this.operatorOnRunner(caller, runnerId);
    const output = skillOutput(
      'skill.search',
      await this.commands.send(
        runnerId,
        'skill.search',
        { query },
        { role, ctx: caller.ctx },
      ),
    );
    return { items: output.items };
  }

  /**
   * Inspects a repository on the runner (D2) and stores one preview per skill
   * it holds, installable by this caller only, for 15 minutes.
   */
  async inspect(
    caller: SkillCaller,
    dto: SkillInspectDto,
  ): Promise<SkillInspectView> {
    let role = await this.operatorOnRunner(caller, dto.runnerId);
    if (dto.projectId) {
      const access = await this.access.resolve(caller.user, dto.projectId);
      const project = access
        ? await this.prisma.project.findUnique({
            where: { id: dto.projectId },
            select: { runnerId: true },
          })
        : null;
      if (!access || project?.runnerId !== dto.runnerId) {
        throw skillsError(404, SKILLS_ERROR.notFound, 'Project not found');
      }
      if (!projectRoleAtLeast(access.role, 'operator')) {
        throw skillsError(
          403,
          SKILLS_ERROR.forbidden,
          'This needs the operator role on the project',
        );
      }
      role = access.role;
    }
    const output = skillOutput(
      'skill.inspect',
      await this.commands.send(
        dto.runnerId,
        'skill.inspect',
        {
          source: dto.source,
          ...(dto.skillId ? { skillId: dto.skillId } : {}),
          ...(dto.ref ? { ref: dto.ref } : {}),
        },
        { role, ctx: caller.ctx },
      ),
    );
    const expiresAt = new Date(Date.now() + SKILL_PREVIEW_TTL_MS);
    const rows = await this.prisma.$transaction(
      output.skills.map((skill) =>
        this.prisma.skillInstallPreview.create({
          data: {
            runnerId: dto.runnerId,
            projectId: dto.projectId ?? null,
            userId: caller.user.id,
            source: dto.source,
            skillId: skill.skillId,
            commit: output.commit,
            contentHash: skill.contentHash,
            files: asJson({
              path: skill.path,
              files: skill.files,
            } satisfies PreviewPayload),
            frontmatter: asJson(skill.frontmatter),
            expiresAt,
          },
        }),
      ),
    );
    return { commit: output.commit, previews: rows.map(toPreviewView) };
  }

  /**
   * D4: a project install opens a PR on the runner, which takes minutes. The
   * `command_runs` row (#17) is returned at once and finished when the
   * runner answers; `command_run.updated` on `project:<id>` tells the page.
   */
  async installToProject(
    caller: ProjectSkillCaller,
    project: SkillProject,
    dto: SkillInstallDto,
  ): Promise<CommandRunView> {
    const target = {
      scope: 'project' as const,
      projectId: project.id,
      root: project.rootPath,
      base: project.base,
      runtime: dto.runtime,
    };
    const preview = await this.takePreview(
      caller,
      dto.previewId,
      project.runnerId,
      project.id,
      target,
      caller.role,
    );
    try {
      this.commands.assertReady(project.runnerId, 'skill.install');
    } catch (error) {
      await this.releasePreview(preview.id, 'command_unavailable');
      throw error;
    }
    const args = installArgs(preview, target);
    const run = await this.runs.create({
      projectId: project.id,
      runnerId: project.runnerId,
      userId: caller.user.id,
      command: 'skill.install',
      args,
    });
    const work = this.finishProjectInstall(
      caller,
      project,
      run.id,
      preview.id,
      args,
    )
      .catch((error: unknown) =>
        this.logger.error(
          `skill.install ${run.id}: ${(error as Error).message}`,
        ),
      )
      .finally(() => this.pending.delete(work));
    this.pending.add(work);
    return run;
  }

  private async finishProjectInstall(
    caller: ProjectSkillCaller,
    project: SkillProject,
    runId: string,
    previewId: string,
    args: SkillInstallArgs,
  ): Promise<void> {
    const result = await this.commands
      .send(project.runnerId, 'skill.install', args, {
        role: caller.role,
        ctx: caller.ctx,
      })
      .catch((error: unknown) => {
        if (error instanceof SkillsFailure) {
          return {
            status: 'error' as const,
            error: { code: 'internal' as const, message: error.message },
          };
        }
        throw error;
      });
    if (result.status === 'ok') {
      await this.runs.finish(runId, { status: 'ok', result: result.output });
      await this.recordInstall(caller, args, 'ok', {
        commandRunId: runId,
        ...result.output,
      });
      await this.inventory
        .refresh(project, caller)
        .catch((error: unknown) =>
          this.logger.warn(
            `inventory rescan after install failed: ${(error as Error).message}`,
          ),
        );
      return;
    }
    if (result.status === 'unknown') {
      await this.runs.finish(runId, {
        status: 'unknown',
        error: {
          code: 'runner_timeout',
          message: 'The runner did not answer skill.install in time',
        },
      });
    } else {
      await this.runs.finish(runId, {
        status: 'error',
        error: {
          code: 'runner_error',
          message: `${result.error.code}${result.error.message ? `: ${result.error.message}` : ''}`,
        },
      });
      await this.releasePreview(previewId, result.error.code);
    }
    await this.recordInstall(caller, args, 'error', {
      commandRunId: runId,
      error: result.status === 'error' ? result.error.code : 'unknown',
    });
  }

  /** D3: a profile install writes directly; it needs admin (D14). */
  async installToProfile(
    caller: SkillCaller,
    runnerId: string,
    profileKey: string,
    dto: SkillInstallDto,
  ): Promise<SkillProfileInstallView> {
    const target = {
      scope: 'profile' as const,
      profileKey: parseParam(profileKeySchema, profileKey, 'profile key'),
      runtime: dto.runtime,
    };
    const preview = await this.takePreview(
      caller,
      dto.previewId,
      runnerId,
      null,
      target,
      caller.user.role,
    );
    await this.profile(runnerId, target.profileKey, target.runtime);
    const args = installArgs(preview, target);
    try {
      const output = skillOutput(
        'skill.install',
        await this.commands.send(runnerId, 'skill.install', args, {
          role: caller.user.role,
          ctx: caller.ctx,
        }),
      );
      await this.recordInstall(caller, args, 'ok', { ...output });
      await this.rescanRunner(runnerId, caller);
      return { path: output.path };
    } catch (error) {
      if (error instanceof SkillsFailure) {
        await this.releasePreview(preview.id, error.code);
        await this.recordInstall(caller, args, 'error', { error: error.code });
      }
      throw error;
    }
  }

  /** Profile scope only (spec, Protocol); admin. */
  async uninstall(
    caller: SkillCaller,
    runnerId: string,
    params: { profileKey: string; runtime: string; name: string },
  ): Promise<{ removed: true }> {
    const args = {
      profileKey: parseParam(
        profileKeySchema,
        params.profileKey,
        'profile key',
      ),
      runtime: parseRuntime(params.runtime),
      name: parseParam(skillNameSchema, params.name, 'skill name'),
    };
    const runner = await this.prisma.runner.findUnique({
      where: { id: runnerId },
      select: { id: true },
    });
    if (!runner) throw runnerNotFound();
    const record = (result: AuditResult, meta: object = {}) =>
      this.audit.record({
        ...caller.ctx,
        action: 'skill.uninstalled',
        target: { type: 'skill', id: args.name },
        after: { runnerId, ...args },
        result,
        meta,
      });
    try {
      const output = skillOutput(
        'skill.uninstall',
        await this.commands.send(runnerId, 'skill.uninstall', args, {
          role: caller.user.role,
          ctx: caller.ctx,
        }),
      );
      await record('ok');
      await this.rescanRunner(runnerId, caller);
      return output;
    } catch (error) {
      if (error instanceof SkillsFailure) {
        await record('error', { error: error.code });
      }
      throw error;
    }
  }

  /**
   * The caller's own unexpired, unconsumed preview for this runner (and
   * project), consumed here so it installs once. The role check of D14 comes
   * first: a refused install never consumes the preview.
   */
  private async takePreview(
    caller: SkillCaller,
    previewId: string,
    runnerId: string,
    projectId: string | null,
    target: SkillInstallArgs['target'],
    role: Role,
  ) {
    const minRole = skillInstallMinRole({ target });
    if (!roleAtLeast(role, minRole)) {
      await this.audit.record({
        ...caller.ctx,
        action: 'skill.installed',
        target: { type: 'skill', id: null },
        projectId,
        after: { previewId, target: { ...target } },
        result: 'denied',
        meta: { reason: 'forbidden' },
      });
      throw skillsError(
        403,
        SKILLS_ERROR.forbidden,
        `A ${target.scope} install needs the ${minRole} role`,
      );
    }
    const preview = await this.prisma.skillInstallPreview.findUnique({
      where: { id: previewId },
    });
    if (
      !preview ||
      preview.userId !== caller.user.id ||
      preview.runnerId !== runnerId ||
      (preview.projectId !== null && preview.projectId !== projectId)
    ) {
      throw skillsError(404, SKILLS_ERROR.previewNotFound, 'Preview not found');
    }
    if (preview.expiresAt.getTime() <= Date.now()) {
      throw skillsError(
        410,
        SKILLS_ERROR.previewExpired,
        'The preview expired; inspect the skill again',
      );
    }
    const taken = await this.prisma.skillInstallPreview.updateMany({
      where: { id: preview.id, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    if (taken.count === 0) {
      throw skillsError(
        409,
        SKILLS_ERROR.previewConsumed,
        'This preview was already installed',
      );
    }
    return preview;
  }

  /**
   * An install that failed for a reason other than the content gives the
   * preview back, so the person can retry without inspecting again. A
   * changed or already-installed skill keeps it consumed.
   */
  private async releasePreview(previewId: string, code: string): Promise<void> {
    if (code === 'changed_since_preview' || code === 'already_exists') return;
    await this.prisma.skillInstallPreview.update({
      where: { id: previewId },
      data: { consumedAt: null },
    });
  }

  private async profile(
    runnerId: string,
    key: string,
    runtime: Runtime,
  ): Promise<void> {
    const profile = await this.prisma.runtimeProfile.findUnique({
      where: { runnerId_key: { runnerId, key } },
      select: { runtime: true, missing: true },
    });
    if (!profile || profile.missing) {
      throw skillsError(
        422,
        SKILLS_ERROR.unknownProfile,
        `No profile ${key} on this runner`,
      );
    }
    if (profile.runtime !== runtime) {
      throw skillsError(
        422,
        SKILLS_ERROR.invalidArgs,
        `Profile ${key} is a ${profile.runtime} profile`,
      );
    }
  }

  private async rescanRunner(
    runnerId: string,
    caller: SkillCaller,
  ): Promise<void> {
    try {
      const output = skillOutput(
        'skill.list',
        await this.commands.send(
          runnerId,
          'skill.list',
          {},
          { role: caller.user.role, ctx: caller.ctx },
        ),
      );
      await this.inventory.replace(runnerId, null, output.items);
    } catch (error) {
      this.logger.warn(
        `inventory rescan of runner ${runnerId} failed: ${(error as Error).message}`,
      );
    }
  }

  private recordInstall(
    caller: SkillCaller,
    args: SkillInstallArgs,
    result: AuditResult,
    meta: object,
  ) {
    return this.audit.record({
      ...caller.ctx,
      action: 'skill.installed',
      target: { type: 'skill', id: args.skillId },
      projectId: args.target.scope === 'project' ? args.target.projectId : null,
      after: {
        source: args.source,
        skillId: args.skillId,
        commit: args.commit,
        contentHash: args.contentHash,
        target:
          args.target.scope === 'project'
            ? { scope: 'project', runtime: args.target.runtime }
            : {
                scope: 'profile',
                profileKey: args.target.profileKey,
                runtime: args.target.runtime,
              },
      },
      result,
      meta,
    });
  }
}

const installArgs = (
  preview: {
    source: string;
    skillId: string;
    commit: string;
    contentHash: string;
  },
  target: SkillInstallArgs['target'],
): SkillInstallArgs => ({
  source: preview.source,
  skillId: preview.skillId,
  commit: preview.commit,
  contentHash: preview.contentHash,
  target,
});

const parseParam = (
  schema: { safeParse: (v: unknown) => { success: boolean } },
  value: string,
  what: string,
): string => {
  if (!schema.safeParse(value).success) {
    throw skillsError(400, SKILLS_ERROR.invalidArgs, `Invalid ${what}`);
  }
  return value;
};

const parseRuntime = (value: string): Runtime => {
  if (value !== 'claude' && value !== 'codex') {
    throw skillsError(400, SKILLS_ERROR.invalidArgs, 'Invalid runtime');
  }
  return value;
};

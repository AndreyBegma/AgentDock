import type {
  OrchestratorProfileRef,
  OrchestratorSettingsView,
  Role,
} from '@agentdock/shared';
import {
  ORCHESTRATOR_DEFAULTS,
  type OrchestratorPermissionMode,
} from '@agentdock/shared/protocol';
import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import type { AuditContext } from '../audit/audit.types';
import { PrismaService } from '../database/prisma.service';
import { projectNotFound } from '../projects';
import { ControlFailure } from './control-error';
import type { OrchestratorSettingsDto } from './dto';

const PROFILE_SELECT = {
  id: true,
  key: true,
  label: true,
  runtime: true,
  runnerId: true,
  missing: true,
} satisfies Prisma.RuntimeProfileSelect;

type ProfileRow = Prisma.RuntimeProfileGetPayload<{
  select: typeof PROFILE_SELECT;
}>;

const profileRef = (p: ProfileRow): OrchestratorProfileRef => ({
  id: p.id,
  key: p.key,
  label: p.label,
  runtime: p.runtime,
});

/** The orchestrator a start would launch, with its project. */
export interface ResolvedLaunch {
  projectId: string;
  runnerId: string;
  rootPath: string;
  /** null: no profile set on the request, the settings or the project. */
  profile: ProfileRow | null;
  model: string;
  permissionMode: OrchestratorPermissionMode;
}

/** D3: bypassing permission prompts is chosen by an admin only. */
export const BYPASS_NEEDS_ADMIN =
  '`bypassPermissions` needs the admin role on the project';

/**
 * The project's orchestrator defaults (spec 17 D3): the settings row, the D3
 * defaults when there is none, and the project's default profile (#10 D13)
 * when the row names no profile.
 */
@Injectable()
export class OrchestratorSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async get(projectId: string): Promise<OrchestratorSettingsView> {
    const { settings, project } = await this.load(projectId);
    const effective = settings?.profile ?? project.defaultProfile;
    return {
      profileId: settings?.profileId ?? null,
      model: settings?.model ?? ORCHESTRATOR_DEFAULTS.model,
      permissionMode:
        settings?.permissionMode ?? ORCHESTRATOR_DEFAULTS.permissionMode,
      effectiveProfile: effective ? profileRef(effective) : null,
      updatedAt: settings?.updatedAt.toISOString() ?? null,
      updatedBy: settings?.updatedBy ?? null,
    };
  }

  /**
   * Changes the fields sent. Refused with 403 — and audited `denied` — when a
   * non-admin sets `bypassPermissions`; a profile that is not usable for the
   * orchestrator on this project is 422.
   */
  async update(
    caller: {
      projectId: string;
      role: Role;
      userId: string;
      ctx: AuditContext;
    },
    dto: OrchestratorSettingsDto,
  ): Promise<OrchestratorSettingsView> {
    const { projectId } = caller;
    const before = await this.get(projectId);
    const record = (result: 'ok' | 'denied', after: object, meta = {}) =>
      this.audit.record({
        ...caller.ctx,
        action: 'orchestrator.settings',
        target: { type: 'project', id: projectId },
        projectId,
        before: {
          profileId: before.profileId,
          model: before.model,
          permissionMode: before.permissionMode,
        },
        after,
        result,
        meta,
      });

    try {
      if (
        dto.permissionMode === 'bypassPermissions' &&
        caller.role !== 'admin'
      ) {
        throw new ControlFailure(403, 'forbidden', BYPASS_NEEDS_ADMIN);
      }
      if (dto.profileId) {
        const { project } = await this.load(projectId);
        await this.usableProfile(project.runnerId, dto.profileId);
      }
    } catch (error) {
      if (error instanceof ControlFailure) {
        await record('denied', { ...dto }, { reason: error.code });
        throw error.toHttp();
      }
      throw error;
    }

    const data = {
      ...(dto.profileId !== undefined ? { profileId: dto.profileId } : {}),
      ...(dto.model !== undefined ? { model: dto.model } : {}),
      ...(dto.permissionMode !== undefined
        ? { permissionMode: dto.permissionMode }
        : {}),
      updatedById: caller.userId,
    };
    await this.prisma.projectOrchestratorSettings.upsert({
      where: { projectId },
      create: { projectId, ...data },
      update: data,
    });
    const after = await this.get(projectId);
    await record('ok', {
      profileId: after.profileId,
      model: after.model,
      permissionMode: after.permissionMode,
    });
    return after;
  }

  /**
   * What `orchestrator.start` sends, request overrides first (D3). Throws a
   * `ControlFailure` for a profile it cannot use; a missing profile is not an
   * error here — the caller refuses it with `no_profile`.
   */
  async resolveLaunch(
    projectId: string,
    request: {
      profileId?: string;
      model?: string;
      permissionMode?: OrchestratorPermissionMode;
    },
  ): Promise<ResolvedLaunch> {
    const { settings, project } = await this.load(projectId);
    const profileId =
      request.profileId ?? settings?.profileId ?? project.defaultProfileId;
    return {
      projectId,
      runnerId: project.runnerId,
      rootPath: project.rootPath,
      profile: profileId
        ? await this.usableProfile(project.runnerId, profileId)
        : null,
      model: request.model ?? settings?.model ?? ORCHESTRATOR_DEFAULTS.model,
      permissionMode:
        request.permissionMode ??
        settings?.permissionMode ??
        ORCHESTRATOR_DEFAULTS.permissionMode,
    };
  }

  /** A profile of the project's runner, still reported, on a runtime that runs the orchestrator. */
  private async usableProfile(
    runnerId: string,
    profileId: string,
  ): Promise<ProfileRow> {
    const profile = await this.prisma.runtimeProfile.findUnique({
      where: { id: profileId },
      select: PROFILE_SELECT,
    });
    if (!profile || profile.runnerId !== runnerId || profile.missing) {
      throw new ControlFailure(
        422,
        'unknown_profile',
        'The profile is not one of the project runner’s current profiles',
      );
    }
    if (profile.runtime !== 'claude') {
      throw new ControlFailure(
        422,
        'unsupported_runtime',
        `The orchestrator runs on claude; ${profile.key} is a ${profile.runtime} profile`,
      );
    }
    return profile;
  }

  private async load(projectId: string) {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: {
        runnerId: true,
        rootPath: true,
        defaultProfileId: true,
        defaultProfile: { select: PROFILE_SELECT },
        orchestratorSettings: {
          select: {
            profileId: true,
            model: true,
            permissionMode: true,
            updatedAt: true,
            profile: { select: PROFILE_SELECT },
            updatedBy: { select: { id: true, email: true } },
          },
        },
      },
    });
    if (!project) throw projectNotFound();
    return { project, settings: project.orchestratorSettings };
  }
}

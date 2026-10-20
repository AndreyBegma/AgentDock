import {
  type NoProfileDetails,
  noProfileDetails,
  noProfileMessage,
  type ProfileCandidate,
  pickRuntimeProfile,
  type RuntimeProfilePick,
} from '@nautelle/shared';
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';

/** What the rule reads of a project. */
export interface ProfileProject {
  id: string;
  runnerId: string;
  defaultProfileId: string | null;
}

/** A `runtime_profiles` row as the rule and its callers read it. */
export type ResolvedProfile = ProfileCandidate;

/** Builds a module's own `422 no_profile` failure from D2's details. */
export type NoProfileFailure = (
  details: NoProfileDetails,
  message: string,
) => Error;

const PROFILE_SELECT = {
  id: true,
  key: true,
  label: true,
  runtime: true,
  runnerId: true,
  missing: true,
} as const;

/**
 * The one runtime-profile rule of every model-running action (#272 D1): the
 * explicit key, else the orchestrator profile, else the project default —
 * the first that is set decides. A refusal is D2's `no_profile`, thrown with
 * the caller's own failure class so its module's catches keep working.
 */
@Injectable()
export class RuntimeProfileResolver {
  constructor(private readonly prisma: PrismaService) {}

  /** D1's pick; `key` is a key the action names (plan create, plan turn). */
  async resolve(
    project: ProfileProject,
    options: { key?: string | null } = {},
  ): Promise<RuntimeProfilePick<ResolvedProfile>> {
    const { key } = options;
    const [explicit, settings] = await Promise.all([
      key
        ? this.prisma.runtimeProfile.findUnique({
            where: { runnerId_key: { runnerId: project.runnerId, key } },
            select: PROFILE_SELECT,
          })
        : null,
      key
        ? null
        : this.prisma.projectOrchestratorSettings.findUnique({
            where: { projectId: project.id },
            select: { profileId: true },
          }),
    ]);
    const [orchestrator, fallback] = await Promise.all([
      this.byId(settings?.profileId ?? null),
      this.byId(key ? null : project.defaultProfileId),
    ]);
    return pickRuntimeProfile({
      runnerId: project.runnerId,
      explicit: key ? { key, profile: explicit } : null,
      orchestrator,
      default: fallback,
    });
  }

  /** The usable profile, or `fail(details, message)` thrown (D2). */
  async require(
    project: ProfileProject,
    options: { key?: string | null },
    fail: NoProfileFailure,
  ): Promise<ResolvedProfile> {
    const pick = await this.resolve(project, options);
    if (pick.ok) return pick.profile;
    const details: NoProfileDetails = noProfileDetails(pick) ?? {
      reason: 'none',
      source: null,
    };
    throw fail(
      details,
      noProfileMessage({ ...details, runtime: pick.profile?.runtime }),
    );
  }

  private byId(id: string | null): Promise<ResolvedProfile | null> {
    return id
      ? this.prisma.runtimeProfile.findUnique({
          where: { id },
          select: PROFILE_SELECT,
        })
      : Promise.resolve(null);
  }
}

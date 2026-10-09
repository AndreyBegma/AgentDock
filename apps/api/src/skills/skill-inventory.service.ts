import type { InstalledSkillsView, Role } from '@agentdock/shared';
import type { InstalledSkill } from '@agentdock/shared/protocol';
import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { AuditContext } from '../audit/audit.types';
import { PrismaService } from '../database/prisma.service';
import { projectNotFound } from '../projects';
import { SkillCommands, skillOutput } from './skill-commands';
import { toInstalledSkillView } from './skill-mapper';

/** The project a skills route works on, as the runner knows it. */
export interface SkillProject {
  id: string;
  runnerId: string;
  rootPath: string;
  /** `baseOverride` when set, else the detected base (#10). */
  base: string;
  defaultProfileId: string | null;
}

const PROJECT_SELECT = {
  id: true,
  runnerId: true,
  rootPath: true,
  baseBranch: true,
  baseOverride: true,
  defaultProfileId: true,
} satisfies Prisma.ProjectSelect;

/** The rows a scan replaces: the runner's profile and plugin rows, and one project's. */
const scanScope = (
  runnerId: string,
  projectId: string | null,
): Prisma.InstalledSkillWhereInput => ({
  runnerId,
  OR: [
    { scope: { in: ['profile', 'plugin'] } },
    ...(projectId ? [{ scope: 'project' as const, projectId }] : []),
  ],
});

const keyOf = (s: InstalledSkill): string =>
  [s.scope, s.projectId ?? '', s.profileKey ?? '', s.runtime, s.name].join(
    '\u0000',
  );

/**
 * The skills inventory (spec 24 D6): `installed_skills` is a cache of the
 * runner's last `skill.list`, replaced per scan. Its unique key always has a
 * null column (project rows have no `profileKey`, the others no
 * `projectId`), so a scan replaces its rows in one transaction under a
 * per-runner lock instead of relying on the index.
 */
@Injectable()
export class SkillInventoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly commands: SkillCommands,
  ) {}

  async project(projectId: string): Promise<SkillProject> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: PROJECT_SELECT,
    });
    if (!project) throw projectNotFound();
    return {
      id: project.id,
      runnerId: project.runnerId,
      rootPath: project.rootPath,
      base: project.baseOverride ?? project.baseBranch,
      defaultProfileId: project.defaultProfileId,
    };
  }

  /** This project's skills, and the profile and plugin skills of its runner. */
  async list(projectId: string): Promise<InstalledSkillsView> {
    const project = await this.project(projectId);
    const rows = await this.prisma.installedSkill.findMany({
      where: scanScope(project.runnerId, project.id),
      orderBy: [{ scope: 'asc' }, { invocation: 'asc' }, { runtime: 'asc' }],
    });
    const scannedAt = rows.reduce<Date | null>(
      (latest, r) => (latest && latest > r.seenAt ? latest : r.seenAt),
      null,
    );
    return {
      items: rows.map(toInstalledSkillView),
      scannedAt: scannedAt?.toISOString() ?? null,
    };
  }

  /** Rescans through `skill.list` and replaces the inventory it covers. */
  async refresh(
    project: SkillProject,
    caller: { role: Role; ctx: AuditContext },
  ): Promise<InstalledSkillsView> {
    const output = skillOutput(
      'skill.list',
      await this.commands.send(
        project.runnerId,
        'skill.list',
        { projectId: project.id, root: project.rootPath },
        caller,
      ),
    );
    await this.replace(project.runnerId, project.id, output.items);
    return this.list(project.id);
  }

  /**
   * Replaces the rows one scan covers. Project rows for another project than
   * the one scanned are dropped: a runner reports only what it was asked.
   */
  async replace(
    runnerId: string,
    projectId: string | null,
    items: readonly InstalledSkill[],
    seenAt = new Date(),
  ): Promise<void> {
    const kept = new Map<string, InstalledSkill>();
    for (const item of items) {
      if (item.scope === 'project' && item.projectId !== projectId) continue;
      kept.set(keyOf(item), item);
    }
    const data = [...kept.values()].map(
      (s): Prisma.InstalledSkillCreateManyInput => ({
        runnerId,
        projectId: s.scope === 'project' ? (s.projectId ?? null) : null,
        profileKey: s.scope === 'project' ? null : (s.profileKey ?? null),
        scope: s.scope,
        runtime: s.runtime,
        name: s.name,
        invocation: s.invocation,
        path: s.path,
        description: s.description ?? null,
        argumentHint: s.argumentHint ?? null,
        source: s.source ?? null,
        commit: s.commit ?? null,
        contentHash: s.contentHash ?? null,
        pluginVersion: s.pluginVersion ?? null,
        seenAt,
      }),
    );
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`agentdock:skills:${runnerId}`}))`;
      await tx.installedSkill.deleteMany({
        where: scanScope(runnerId, projectId),
      });
      if (data.length > 0) await tx.installedSkill.createMany({ data });
    });
  }

  /** Whether `invocation` is in this project's inventory. */
  async has(project: SkillProject, invocation: string): Promise<boolean> {
    const row = await this.prisma.installedSkill.findFirst({
      where: { ...scanScope(project.runnerId, project.id), invocation },
      select: { id: true },
    });
    return row !== null;
  }
}

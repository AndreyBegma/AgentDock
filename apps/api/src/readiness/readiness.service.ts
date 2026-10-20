import {
  DOCS_SPEC_COMMAND,
  type ProjectReadinessView,
  projectReadiness,
  READINESS_ACTION_COMMANDS,
  suggestRuntimeProfile,
} from '@nautelle/shared';
import type { CommandName } from '@nautelle/shared/protocol';
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { resolveSpecTarget } from '../planner/spec-target';
import { projectNotFound } from '../projects';
import { RunnerPresence } from '../runners/runner-presence';
import { RuntimeProfileResolver } from './runtime-profile.resolver';

/** Every command an action of D3 needs, once — and #379's docs-repo write. */
const ACTION_COMMANDS: readonly CommandName[] = [
  ...new Set<CommandName>([
    ...Object.values(READINESS_ACTION_COMMANDS).flat(),
    DOCS_SPEC_COMMAND,
  ]),
];

/**
 * Project readiness (#272 D3, D4): the facts from database rows and runner
 * presence — never the project filesystem (ADR-0001) — run through the pure
 * `projectReadiness`.
 */
@Injectable()
export class ReadinessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly presence: RunnerPresence,
    private readonly resolver: RuntimeProfileResolver,
  ) {}

  async view(projectId: string): Promise<ProjectReadinessView> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: {
        id: true,
        runnerId: true,
        defaultProfileId: true,
        rootPath: true,
        codeSentinelConfig: true,
        shipSessionContent: true,
        docsSource: {
          select: { kind: true, localPath: true, repo: true, specDir: true },
        },
      },
    });
    if (!project) throw projectNotFound();
    const [pick, profiles] = await Promise.all([
      this.resolver.resolve(project),
      this.prisma.runtimeProfile.findMany({
        where: { runnerId: project.runnerId },
        select: {
          id: true,
          key: true,
          label: true,
          runtime: true,
          runnerId: true,
          missing: true,
        },
      }),
    ]);
    const runnerConnected = this.presence.isConnected(project.runnerId);
    const missingCommands = runnerConnected
      ? ACTION_COMMANDS.filter(
          (name) =>
            this.presence.commandSupport(project.runnerId, name) === 'missing',
        )
      : [];
    const suggestion = suggestRuntimeProfile(profiles, project.runnerId);
    const chosen = pick.profile;
    return {
      profile:
        chosen && pick.source
          ? { key: chosen.key, label: chosen.label, source: pick.source }
          : null,
      suggestion: suggestion
        ? { id: suggestion.id, key: suggestion.key, label: suggestion.label }
        : null,
      actions: projectReadiness({
        profile: pick,
        runnerConnected,
        missingCommands,
        specTarget: resolveSpecTarget(project).kind,
        shipSessionContent: project.shipSessionContent,
      }),
    };
  }
}

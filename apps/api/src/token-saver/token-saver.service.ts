import {
  isActiveRoundPhase,
  TOKEN_SAVER_DEFAULT,
  type TokenSaverConfig,
  type TokenSaverSettingsView,
} from '@nautelle/shared';
import {
  capabilitiesSchema,
  tokenSaverAvailable,
} from '@nautelle/shared/protocol';
import { Injectable } from '@nestjs/common';
import type { TokenSaverSettings } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import type { AuditContext } from '../audit/audit.types';
import { PrismaService } from '../database/prisma.service';
import { projectNotFound } from '../projects';

/**
 * What a launch sender adds to its command and to its run row (#445 D11,
 * amendment 4): `args` carries `tokenSaver` only for a runner that advertises
 * the capability — every launch args schema is strict, so an older runner
 * would refuse the field; `on` is `runs.tokenSaver` — the launch carried
 * `tokenSaver.enabled`.
 */
export interface TokenSaverLaunch {
  args: { tokenSaver?: TokenSaverConfig };
  on: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A launch exactly as before #445. */
export const TOKEN_SAVER_OFF: TokenSaverLaunch = { args: {}, on: false };

const configOf = (row: TokenSaverSettings | null): TokenSaverConfig =>
  row ? { enabled: row.enabled, mcpAllow: row.mcpAllow } : TOKEN_SAVER_DEFAULT;

/**
 * The per-project Token saver setting (#445 D11, ADR-0039): no row is on with
 * an empty allowlist. Every launch sender asks `launch()` what to send.
 */
@Injectable()
export class TokenSaverService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async view(projectId: string): Promise<TokenSaverSettingsView> {
    const row = await this.prisma.tokenSaverSettings.findUnique({
      where: { projectId },
    });
    return {
      ...configOf(row),
      updatedAt: row?.updatedAt.toISOString() ?? null,
    };
  }

  /** A project admin; audited with the setting before and after. */
  async update(
    projectId: string,
    config: TokenSaverConfig,
    actor: { userId: string; ctx: AuditContext },
  ): Promise<TokenSaverSettingsView> {
    const before = await this.view(projectId);
    const data = {
      enabled: config.enabled,
      mcpAllow: config.mcpAllow,
      updatedById: actor.userId,
    };
    const row = await this.prisma.tokenSaverSettings.upsert({
      where: { projectId },
      create: { projectId, ...data },
      update: data,
    });
    const after = configOf(row);
    await this.audit.record({
      ...actor.ctx,
      action: 'project.update',
      target: { type: 'project', id: projectId },
      projectId,
      before: {
        tokenSaver: { enabled: before.enabled, mcpAllow: before.mcpAllow },
      },
      after: { tokenSaver: after },
      result: 'ok',
    });
    return { ...after, updatedAt: row.updatedAt.toISOString() };
  }

  /** What the next launch of the project sends and records. */
  async launch(projectId: string): Promise<TokenSaverLaunch> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: {
        runner: { select: { capabilities: true } },
        tokenSaverSettings: true,
      },
    });
    if (!project) throw projectNotFound();
    const capabilities = capabilitiesSchema.safeParse(
      project.runner.capabilities,
    );
    if (!capabilities.success || !tokenSaverAvailable(capabilities.data)) {
      return TOKEN_SAVER_OFF;
    }
    const tokenSaver = configOf(project.tokenSaverSettings);
    return { args: { tokenSaver }, on: tokenSaver.enabled };
  }

  /**
   * #445 D8: the runner's artifact guard accepted this session's finish after
   * 2 rejections — the active round's run is marked, and the card shows
   * **Description incomplete**. The card is found as `finishByWorker` finds
   * it; no card or no active round marks nothing.
   */
  async markArtifactIncomplete(
    project: { id: string; runnerId: string },
    sessionId: string,
  ): Promise<void> {
    // `board_cards.sessionId` is a uuid column.
    if (!UUID.test(sessionId)) return;
    const card = await this.prisma.boardCard.findFirst({
      where: {
        projectId: project.id,
        sessionId,
        project: { runnerId: project.runnerId },
      },
      select: {
        rounds: {
          orderBy: { round: 'desc' },
          take: 1,
          select: { runId: true, phase: true },
        },
      },
    });
    const round = card?.rounds[0];
    if (!round || !isActiveRoundPhase(round.phase)) return;
    await this.prisma.run.update({
      where: { id: round.runId },
      data: { artifactIncomplete: true },
    });
  }
}

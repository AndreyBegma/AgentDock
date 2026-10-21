import {
  CARD_TYPES,
  isActiveRoundPhase,
  mcpByTypeSchema,
  PREFIX_BUDGET_DEFAULT_TOKENS,
  type PrefixByType,
  prefixByTypeOf,
  skillsOffByTypeSchema,
  type TechniqueFlags,
  TOKEN_SAVER_DEFAULT,
  type TokenSaverConfig,
  type TokenSaverPrefixSettings,
  type TokenSaverSettingsView,
  type UpdateTokenSaverSettingsBody,
} from '@nautelle/shared';
import {
  type CardTokenSaver,
  capabilitiesSchema,
  tokenEconomyAvailable,
  tokenSaverAvailable,
} from '@nautelle/shared/protocol';
import { BadRequestException, Injectable } from '@nestjs/common';
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
  args: { tokenSaver?: CardTokenSaver };
  on: boolean;
  /**
   * #746 D11: the technique flags `args.tokenSaver` carries — `runs.techniques`;
   * `null` when the launch carries none.
   */
  techniques: TechniqueFlags | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A launch exactly as before #445. */
export const TOKEN_SAVER_OFF: TokenSaverLaunch = {
  args: {},
  on: false,
  techniques: null,
};

const configOf = (row: TokenSaverSettings | null): TokenSaverConfig =>
  row ? { enabled: row.enabled, mcpAllow: row.mcpAllow } : TOKEN_SAVER_DEFAULT;

/** #751 B3, B5: the prefix settings; no row is the defaults. */
const prefixOf = (
  row: TokenSaverSettings | null,
): TokenSaverPrefixSettings => ({
  prefixBudgetTokens: row?.prefixBudgetTokens ?? PREFIX_BUDGET_DEFAULT_TOKENS,
  mcpByType: prefixByTypeOf(row?.mcpByType, mcpByTypeSchema),
  skillsOffByType: prefixByTypeOf(row?.skillsOffByType, skillsOffByTypeSchema),
});

const viewOf = (row: TokenSaverSettings | null): TokenSaverSettingsView => ({
  ...configOf(row),
  ...prefixOf(row),
  updatedAt: row?.updatedAt.toISOString() ?? null,
});

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
    return viewOf(row);
  }

  /**
   * A project admin; audited with the setting before and after. #751 B5: a
   * per-type MCP list must stay inside `mcpAllow`, and a hidden skill must be
   * one the runner reported for the project; a prefix field left out keeps
   * its value.
   */
  async update(
    projectId: string,
    config: UpdateTokenSaverSettingsBody,
    actor: { userId: string; ctx: AuditContext },
  ): Promise<TokenSaverSettingsView> {
    const before = await this.view(projectId);
    const mcpByType =
      config.mcpByType === undefined
        ? undefined
        : this.checkedByType(config.mcpByType, mcpByTypeSchema, 'mcpByType');
    const skillsOffByType =
      config.skillsOffByType === undefined
        ? undefined
        : this.checkedByType(
            config.skillsOffByType,
            skillsOffByTypeSchema,
            'skillsOffByType',
          );
    const outside = Object.values(mcpByType ?? before.mcpByType)
      .flat()
      .filter((name) => name !== undefined && !config.mcpAllow.includes(name));
    if (outside.length > 0) {
      throw new BadRequestException(
        `mcpByType names a server not in mcpAllow: ${[...new Set(outside)].join(', ')}`,
      );
    }
    if (skillsOffByType !== undefined) {
      await this.assertReportedSkills(projectId, skillsOffByType);
    }
    const data = {
      enabled: config.enabled,
      mcpAllow: config.mcpAllow,
      ...(config.prefixBudgetTokens !== undefined
        ? { prefixBudgetTokens: config.prefixBudgetTokens }
        : {}),
      ...(mcpByType !== undefined ? { mcpByType } : {}),
      ...(skillsOffByType !== undefined ? { skillsOffByType } : {}),
      updatedById: actor.userId,
    };
    const row = await this.prisma.tokenSaverSettings.upsert({
      where: { projectId },
      create: { projectId, ...data },
      update: data,
    });
    const after = viewOf(row);
    const { updatedAt: _before, ...beforeSettings } = before;
    const { updatedAt: _after, ...afterSettings } = after;
    await this.audit.record({
      ...actor.ctx,
      action: 'project.update',
      target: { type: 'project', id: projectId },
      projectId,
      before: { tokenSaver: beforeSettings },
      after: { tokenSaver: afterSettings },
      result: 'ok',
    });
    return after;
  }

  private checkedByType(
    value: unknown,
    schema: typeof mcpByTypeSchema | typeof skillsOffByTypeSchema,
    field: string,
  ): PrefixByType {
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      throw new BadRequestException(
        `${field} must map card types (${CARD_TYPES.join(', ')}) to lists of names`,
      );
    }
    for (const [type, names] of Object.entries(parsed.data)) {
      if (names && new Set(names).size !== names.length) {
        throw new BadRequestException(`${field}.${type} has a duplicate`);
      }
    }
    return parsed.data;
  }

  /** B5: only skills the runner reported in a launch of the project. */
  private async assertReportedSkills(
    projectId: string,
    byType: PrefixByType,
  ): Promise<void> {
    const named = [...new Set(Object.values(byType).flat())].filter(
      (n): n is string => n !== undefined,
    );
    if (named.length === 0) return;
    const reported = new Set(
      (
        await this.prisma.runPrefixPart.findMany({
          where: { projectId, kind: 'skill', name: { in: named } },
          distinct: ['name'],
          select: { name: true },
        })
      ).map((p) => p.name),
    );
    const unknown = named.filter((n) => !reported.has(n));
    if (unknown.length > 0) {
      throw new BadRequestException(
        `skillsOffByType names a skill no launch reported: ${unknown.join(', ')}`,
      );
    }
  }

  /**
   * What the next launch of the project sends and records. #746: a card
   * launch passes its technique flags; they ride on `tokenSaver` only to a
   * runner that advertises `tokenEconomy` (the args schema is strict).
   */
  async launch(
    projectId: string,
    techniques?: TechniqueFlags,
  ): Promise<TokenSaverLaunch> {
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
    if (techniques === undefined || !tokenEconomyAvailable(capabilities.data)) {
      return { args: { tokenSaver }, on: tokenSaver.enabled, techniques: null };
    }
    return {
      args: { tokenSaver: { ...tokenSaver, techniques } },
      on: tokenSaver.enabled,
      techniques,
    };
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

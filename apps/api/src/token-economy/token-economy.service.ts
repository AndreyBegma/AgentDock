import {
  armForMode,
  type TechniqueFlags,
  type TechniqueMode,
  TOKEN_ECONOMY_DEFAULT_B_SHARE,
  TOKEN_ECONOMY_TECHNIQUES,
  type TokenEconomySettingsView,
  type TokenEconomyTechniqueDef,
  type TokenEconomyTechniqueView,
} from '@nautelle/shared';
import { Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import type { AuditContext } from '../audit/audit.types';
import { PrismaService } from '../database/prisma.service';

interface Actor {
  userId: string;
  ctx: AuditContext;
}

/**
 * Token economy (#746, ADR-0074): the project's B share, each technique's
 * mode, and the card's sticky arms. The registry is the shared
 * `TOKEN_ECONOMY_TECHNIQUES`; the `techniques` argument exists so a test can
 * run against a fixture technique.
 */
@Injectable()
export class TokenEconomyService {
  /** The registered techniques; replaced only by tests. */
  techniques: readonly TokenEconomyTechniqueDef[] = TOKEN_ECONOMY_TECHNIQUES;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  technique(key: string): TokenEconomyTechniqueDef | undefined {
    return this.techniques.find((t) => t.key === key);
  }

  async settings(projectId: string): Promise<TokenEconomySettingsView> {
    const row = await this.prisma.tokenEconomySettings.findUnique({
      where: { projectId },
    });
    return {
      bSharePercent: row?.bSharePercent ?? TOKEN_ECONOMY_DEFAULT_B_SHARE,
      updatedAt: row?.updatedAt.toISOString() ?? null,
    };
  }

  /** A project admin; audited with the share before and after. */
  async updateSettings(
    projectId: string,
    bSharePercent: number,
    actor: Actor,
  ): Promise<TokenEconomySettingsView> {
    const before = await this.settings(projectId);
    const row = await this.prisma.tokenEconomySettings.upsert({
      where: { projectId },
      create: { projectId, bSharePercent, updatedById: actor.userId },
      update: { bSharePercent, updatedById: actor.userId },
    });
    await this.audit.record({
      ...actor.ctx,
      action: 'project.update',
      target: { type: 'project', id: projectId },
      projectId,
      before: { tokenEconomy: { bSharePercent: before.bSharePercent } },
      after: { tokenEconomy: { bSharePercent: row.bSharePercent } },
      result: 'ok',
    });
    return {
      bSharePercent: row.bSharePercent,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /** Every registered technique's mode in the project (D9). */
  async modes(projectId: string): Promise<TokenEconomyTechniqueView[]> {
    const rows = await this.prisma.tokenEconomyTechnique.findMany({
      where: { projectId },
    });
    return this.techniques.map((t) => {
      const row = rows.find((r) => r.technique === t.key);
      return {
        technique: t.key,
        mode: row?.mode ?? t.defaultMode,
        changedAt: row?.changedAt.toISOString() ?? null,
      };
    });
  }

  /**
   * D5, D9: a project admin sets a technique's mode — Enable for all is
   * `on`, Stop is `off`. An unknown technique is 404. Audited.
   */
  async setMode(
    projectId: string,
    technique: string,
    mode: TechniqueMode,
    actor: Actor,
  ): Promise<TokenEconomyTechniqueView> {
    const def = this.technique(technique);
    if (!def) throw new NotFoundException(`Unknown technique "${technique}"`);
    const before =
      (
        await this.prisma.tokenEconomyTechnique.findUnique({
          where: { projectId_technique: { projectId, technique } },
          select: { mode: true },
        })
      )?.mode ?? def.defaultMode;
    const row = await this.prisma.tokenEconomyTechnique.upsert({
      where: { projectId_technique: { projectId, technique } },
      create: { projectId, technique, mode, changedById: actor.userId },
      update: { mode, changedById: actor.userId },
    });
    await this.audit.record({
      ...actor.ctx,
      action: 'project.update',
      target: { type: 'project', id: projectId },
      projectId,
      before: { tokenEconomy: { technique, mode: before } },
      after: { tokenEconomy: { technique, mode: row.mode } },
      result: 'ok',
    });
    return {
      technique,
      mode: row.mode,
      changedAt: row.changedAt.toISOString(),
    };
  }

  /**
   * D2, D10, D11: the technique flags of a card's launch. At the card's first
   * round every registered card technique gets an arm — `ab` draws it, `on` is
   * `b`, `off` is `a` — inserted once (`ON CONFLICT DO NOTHING`, so a racing
   * launch reads the same arms). Later rounds read the stored arms only. A
   * technique registered after the first round has no arm: the card follows
   * the current mode (`ab` counts as off) and is left out of its report.
   */
  async cardFlags(
    projectId: string,
    cardId: string,
    firstRound: boolean,
  ): Promise<TechniqueFlags> {
    const techniques = this.techniques.filter((t) =>
      t.runKinds.includes('card'),
    );
    if (techniques.length === 0) return {};
    const modes = new Map(
      (await this.modes(projectId)).map((m) => [m.technique, m.mode]),
    );
    if (firstRound) {
      const { bSharePercent } = await this.settings(projectId);
      await this.prisma.cardTechniqueArm.createMany({
        data: techniques.map((t) => {
          const mode = modes.get(t.key) ?? t.defaultMode;
          return {
            cardId,
            technique: t.key,
            mode,
            arm: armForMode(mode, cardId, t.key, bSharePercent),
          };
        }),
        skipDuplicates: true,
      });
    }
    const arms = new Map(
      (
        await this.prisma.cardTechniqueArm.findMany({
          where: { cardId },
          select: { technique: true, arm: true },
        })
      ).map((a) => [a.technique, a.arm]),
    );
    return Object.fromEntries(
      techniques.map((t) => {
        const arm = arms.get(t.key);
        return [
          t.key,
          arm !== undefined
            ? arm === 'b'
            : (modes.get(t.key) ?? t.defaultMode) === 'on',
        ];
      }),
    );
  }
}

import {
  type CardPrefix,
  type CardType,
  cardTypeOf,
  compressedRulesSchema,
  launchOverlaySchema,
  mcpByTypeSchema,
  OVERLAY_PART_RULES,
  PROJECT_RULES_BLOCK_MAX_BYTES,
  prefixByTypeOf,
  projectRulesBlock,
  ruleAppliesTo,
  type SessionPrefix,
  sessionPrefixSchema,
  skillsOffByTypeSchema,
  type TechniqueFlags,
} from '@nautelle/shared';
import {
  type Capabilities,
  prefixOverlaysAvailable,
} from '@nautelle/shared/protocol';
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { enabledRules } from './rules-version';

/** S1: the three prefix techniques' keys. */
export const PREFIX_SELECT = 'prefix-select';
export const RULES_COMPRESSED = 'rules-compressed';
export const PREFIX_OVERLAYS = 'prefix-overlays';

export interface PrefixLaunchInput {
  projectId: string;
  card: {
    id: string;
    kind: 'bug' | 'feature';
    sessionPrefix: unknown;
  };
  ciFix: boolean;
  /** The round resumes the card's session as it is (not `fresh`): S2 reuse. */
  reuse: boolean;
  flags: TechniqueFlags;
  /** The launch's `tokenSaver.mcpAllow` — the superset (B5). */
  mcpAllow: readonly string[] | null;
  capabilities: Capabilities | null;
}

export interface PrefixLaunch {
  cardType: CardType;
  /** S2: what `board_cards.sessionPrefix` holds after the launch. */
  session: SessionPrefix;
  /** Whether `session` is new — the caller stores it. */
  started: boolean;
  /** C-227 / B5 / B6: the prompt's rules section for a new session. */
  projectRules: string | null;
  /** `tokenSaver.prefix`; null for a runner without `prefixOverlays`. */
  prefix: CardPrefix | null;
}

/**
 * A card launch's prefix (docs/specs/751 S2, B4–B7). A new session computes
 * the card type and, per the card's arms, the selection, the compressed rules
 * version and the overlays, and freezes them; a resumed round reuses what the
 * session started with. Only approved overlays are ever sent, and a stale one
 * never again (B10).
 */
@Injectable()
export class PrefixLaunchService {
  private readonly logger = new Logger(PrefixLaunchService.name);

  constructor(private readonly prisma: PrismaService) {}

  async resolve(input: PrefixLaunchInput): Promise<PrefixLaunch> {
    const stored = input.reuse
      ? sessionPrefixSchema.safeParse(input.card.sessionPrefix)
      : null;
    const session = stored?.success ? stored.data : await this.freeze(input);
    const started = !stored?.success;
    return {
      cardType: session.cardType,
      session,
      started,
      projectRules: started
        ? await this.rulesSection(input.projectId, session)
        : null,
      prefix:
        input.capabilities !== null &&
        prefixOverlaysAvailable(input.capabilities)
          ? await this.launchPrefix(session)
          : null,
    };
  }

  /** S2: the session's prefix, from the settings and approvals as they are now. */
  private async freeze(input: PrefixLaunchInput): Promise<SessionPrefix> {
    const design = await this.prisma.taskDesign.findUnique({
      where: { cardId: input.card.id },
      select: { status: true, approvedRevisionId: true },
    });
    const cardType = cardTypeOf({
      ciFix: input.ciFix,
      approvedDesign:
        design?.status === 'approved' && design.approvedRevisionId !== null,
      kind: input.card.kind,
    });
    const select = input.flags[PREFIX_SELECT] === true;
    const settings = select
      ? await this.prisma.tokenSaverSettings.findUnique({
          where: { projectId: input.projectId },
          select: { mcpByType: true, skillsOffByType: true },
        })
      : null;
    const mcpSubset = settings
      ? prefixByTypeOf(settings.mcpByType, mcpByTypeSchema)[cardType]
      : undefined;
    const skillsOff = settings
      ? (prefixByTypeOf(settings.skillsOffByType, skillsOffByTypeSchema)[
          cardType
        ] ?? [])
      : [];
    const { version } = await enabledRules(this.prisma, input.projectId);
    const compressed =
      input.flags[RULES_COMPRESSED] === true
        ? await this.prisma.prefixOverlay.findFirst({
            where: {
              projectId: input.projectId,
              part: OVERLAY_PART_RULES,
              state: 'approved',
              rulesVersion: version,
            },
            select: { id: true },
          })
        : null;
    const overlays =
      input.flags[PREFIX_OVERLAYS] === true
        ? await this.prisma.prefixOverlay.findMany({
            where: {
              projectId: input.projectId,
              state: 'approved',
              part: { not: OVERLAY_PART_RULES },
            },
            orderBy: { createdAt: 'asc' },
            select: { id: true },
          })
        : [];
    return {
      cardType,
      select,
      // B5: the per-type subset narrows the setting's `mcpAllow`, never widens it.
      ...(mcpSubset !== undefined && input.mcpAllow !== null
        ? {
            mcpAllow: mcpSubset.filter((name) =>
              input.mcpAllow?.includes(name),
            ),
          }
        : {}),
      skillsOff,
      rulesVersion: version,
      rulesOverlayId: compressed?.id ?? null,
      overlayIds: overlays.map((o) => o.id),
    };
  }

  /**
   * B5, B6: the enabled rules for the session's type (in the `prefix-select`
   * B arm), with the approved compressed texts when the session took them and
   * the rules have not changed since — else the originals.
   */
  private async rulesSection(
    projectId: string,
    session: SessionPrefix,
  ): Promise<string | null> {
    const { rules, version } = await enabledRules(this.prisma, projectId);
    const compressed = await this.compressedTexts(session, version);
    const chosen = rules
      .filter(
        (r) => !session.select || ruleAppliesTo(r.appliesTo, session.cardType),
      )
      .map((r) => {
        const text = compressed?.get(r.id);
        return text ? { ...r, ...text } : r;
      });
    const block = projectRulesBlock(chosen);
    if (block.omitted > 0) {
      this.logger.warn(
        `Project ${projectId}: ${block.omitted} of ${chosen.length} enabled coding rules did not fit the ${PROJECT_RULES_BLOCK_MAX_BYTES}-byte prompt block and were left out`,
      );
    }
    return block.text;
  }

  private async compressedTexts(
    session: SessionPrefix,
    version: string,
  ): Promise<Map<string, { title: string; description: string }> | null> {
    if (session.rulesOverlayId === null || session.rulesVersion !== version) {
      return null;
    }
    const overlay = await this.prisma.prefixOverlay.findUnique({
      where: { id: session.rulesOverlayId },
      select: { state: true, rulesVersion: true, content: true },
    });
    if (overlay?.state !== 'approved' || overlay.rulesVersion !== version) {
      return null;
    }
    const parsed = compressedRulesSchema.safeParse(safeJson(overlay.content));
    if (!parsed.success) return null;
    return new Map(
      parsed.data.rules.map((r) => [
        r.id,
        { title: r.title, description: r.description },
      ]),
    );
  }

  /** The runner's `tokenSaver.prefix`; an overlay no longer approved is left out. */
  private async launchPrefix(session: SessionPrefix): Promise<CardPrefix> {
    const rows =
      session.overlayIds.length === 0
        ? []
        : await this.prisma.prefixOverlay.findMany({
            where: { id: { in: session.overlayIds }, state: 'approved' },
            orderBy: { createdAt: 'asc' },
            select: {
              id: true,
              part: true,
              originalSha256: true,
              content: true,
            },
          });
    const overlays = rows.flatMap((row) => {
      const parsed = launchOverlaySchema.safeParse({
        id: row.id,
        part: row.part,
        originalSha256: row.originalSha256,
        content: row.content,
      });
      return parsed.success ? [parsed.data] : [];
    });
    return {
      cardType: session.cardType,
      ...(session.mcpAllow !== undefined ? { mcpAllow: session.mcpAllow } : {}),
      skillsOff: session.skillsOff,
      overlays,
    };
  }
}

const safeJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

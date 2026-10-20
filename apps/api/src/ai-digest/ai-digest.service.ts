import {
  AI_DIGEST_EVENTS,
  type AiDigestSentEventData,
  type AiDigestSkippedEventData,
  type AiDigestSkipReason,
  type AiDigestView,
  type LlmDefaultModel,
} from '@nautelle/shared';
import { API_EVENT_SOURCE } from '@nautelle/shared/protocol';
import { HttpException, Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { LlmError } from '../llm/llm-error';
import { LlmGateway } from '../llm/llm-gateway.service';
import { LlmStore } from '../llm/llm-store';
import { recordServerEvent } from '../server-events';
import { AiDigestComposer } from './ai-digest-composer';
import {
  AI_DIGEST_SYSTEM,
  aiDigestPrompt,
  aiDigestView,
  boundedOverview,
} from './ai-digest-format';
import { AiDigestTelegram } from './ai-digest-telegram';
import { zonedDueAt } from './ai-digest-time';

/** The period a digest covers: the last day. */
const WINDOW_MS = 24 * 3_600_000;
/** The overview is a few sentences. */
const OVERVIEW_MAX_TOKENS = 600;

/** What one tick did; the e2e suites assert on it. */
export interface AiDigestPass {
  sent: number;
  skipped: number;
}

interface DigestProject {
  id: string;
  displayName: string;
  runnerId: string;
  rootPath: string;
  repo: string;
}

type Outcome =
  | { status: 'sent'; view: AiDigestView }
  | { status: 'skipped'; reason: AiDigestSkipReason; message: string };

const notFound = (): HttpException =>
  new HttpException(
    { statusCode: 404, error: 'not_found', message: 'No digest yet' },
    404,
  );

/**
 * The daily AI digest (#658): at each enabled project's time in its timezone,
 * the last day's Board, PRs and Steward incidents are composed into done,
 * stuck and waiting sections, the default model writes an overview through
 * the gateway (tagged `digest`, under the provider's cap), and the digest is
 * stored, sent to the linked Telegram chats and recorded as an
 * `ai_digest.sent` event. When the gateway refuses — the cap is reached, no
 * model is set — nothing is sent and `ai_digest.skipped` is recorded instead.
 *
 * One `ai_digests` row per `(project, dueAt)` claims the occurrence first, so
 * a repeated or concurrent tick makes nothing twice. A setting changed after
 * today's time starts tomorrow.
 */
@Injectable()
export class AiDigestService {
  private readonly logger = new Logger(AiDigestService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly composer: AiDigestComposer,
    private readonly gateway: LlmGateway,
    private readonly llm: LlmStore,
    private readonly telegram: AiDigestTelegram,
  ) {}

  /** The newest sent digest of the project; 404 before the first one. */
  async latest(projectId: string): Promise<AiDigestView> {
    const row = await this.prisma.aiDigest.findFirst({
      where: { projectId, status: 'sent' },
      orderBy: [{ dueAt: 'desc' }, { id: 'desc' }],
    });
    if (!row) throw notFound();
    return aiDigestView(row);
  }

  /** One scheduler tick: every enabled digest whose time has come today. */
  async tick(now = new Date()): Promise<AiDigestPass> {
    const due = await this.prisma.aiDigestSettings.findMany({
      where: { enabled: true },
      select: {
        time: true,
        timezone: true,
        updatedAt: true,
        project: {
          select: {
            id: true,
            displayName: true,
            runnerId: true,
            rootPath: true,
            repo: true,
          },
        },
      },
    });
    const pass: AiDigestPass = { sent: 0, skipped: 0 };
    for (const settings of due) {
      const dueAt = zonedDueAt(now, settings.time, settings.timezone);
      if (now < dueAt || settings.updatedAt > dueAt) continue;
      try {
        const outcome = await this.run(settings.project, dueAt, now);
        if (outcome === 'sent') pass.sent += 1;
        if (outcome === 'skipped') pass.skipped += 1;
      } catch (error) {
        this.logger.error(
          `AI digest of project ${settings.project.id} failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    return pass;
  }

  /** Claims, makes and delivers one occurrence; null when another tick has it. */
  private async run(
    project: DigestProject,
    dueAt: Date,
    now: Date,
  ): Promise<'sent' | 'skipped' | null> {
    const from = new Date(now.getTime() - WINDOW_MS);
    const { count } = await this.prisma.aiDigest.createMany({
      data: [
        { projectId: project.id, dueAt, status: 'pending', from, to: now },
      ],
      skipDuplicates: true,
    });
    if (count === 0) return null;
    const claimed = await this.prisma.aiDigest.findUniqueOrThrow({
      where: { projectId_dueAt: { projectId: project.id, dueAt } },
      select: { id: true },
    });

    const outcome = await this.make(project, claimed.id, from, now);
    if (outcome.status === 'skipped') {
      await this.prisma.$transaction(async (tx) => {
        await tx.aiDigest.update({
          where: { id: claimed.id },
          data: { status: 'skipped', skipReason: outcome.reason },
        });
        const data: AiDigestSkippedEventData = {
          reason: outcome.reason,
          message: outcome.message,
        };
        await this.event(tx, project, AI_DIGEST_EVENTS.skipped, claimed.id, {
          ...data,
        });
      });
      return 'skipped';
    }

    const delivered = await this.deliver(outcome.view, project.displayName);
    const data: AiDigestSentEventData = {
      digestId: claimed.id,
      done: outcome.view.done.length,
      stuck: outcome.view.stuck.length,
      waiting: outcome.view.waiting.length,
      delivered,
    };
    await this.prisma.$transaction((tx) =>
      this.event(tx, project, AI_DIGEST_EVENTS.sent, claimed.id, { ...data }),
    );
    return 'sent';
  }

  /** Composes the sections and asks the model for the overview; stores a sent digest. */
  private async make(
    project: DigestProject,
    id: string,
    from: Date,
    to: Date,
  ): Promise<Outcome> {
    const model: LlmDefaultModel | null = await this.llm.defaultModel();
    if (!model) {
      return {
        status: 'skipped',
        reason: 'no_model',
        message: 'No default model is set (Admin › AI providers)',
      };
    }
    const facts = await this.composer.compose(project.id, from, to);
    let overview: string;
    try {
      const completion = await this.gateway.complete({
        userId: null,
        feature: 'digest',
        provider: model.provider,
        request: {
          model: model.model,
          system: AI_DIGEST_SYSTEM,
          messages: [
            {
              role: 'user',
              content: aiDigestPrompt(project.displayName, from, to, facts),
            },
          ],
          maxTokens: OVERVIEW_MAX_TOKENS,
        },
      });
      overview = boundedOverview(completion.text);
    } catch (error) {
      if (error instanceof LlmError) {
        return {
          status: 'skipped',
          reason: error.code,
          message: error.message,
        };
      }
      throw error;
    }
    const row = await this.prisma.aiDigest.update({
      where: { id },
      data: {
        status: 'sent',
        content: {
          ...facts.sections,
        } as unknown as Prisma.InputJsonValue,
        overview,
        provider: model.provider,
        model: model.model,
      },
    });
    return { status: 'sent', view: aiDigestView(row) };
  }

  /** Telegram after the digest is stored; a failure here never loses the digest. */
  private async deliver(
    view: AiDigestView,
    projectName: string,
  ): Promise<number> {
    try {
      return await this.telegram.send(view, projectName);
    } catch (error) {
      this.logger.warn(
        `AI digest ${view.id} not delivered: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return 0;
    }
  }

  private event(
    tx: Prisma.TransactionClient,
    project: DigestProject,
    type: string,
    digestId: string,
    data: Prisma.InputJsonObject,
  ): Promise<boolean> {
    return recordServerEvent(tx, {
      source: API_EVENT_SOURCE,
      type,
      ts: new Date(),
      project: {
        runnerId: project.runnerId,
        rootPath: project.rootPath,
        repo: project.repo,
      },
      data,
      dedupeKey: `${type}:${digestId}`,
    });
  }
}

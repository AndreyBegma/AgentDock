import { captureFingerprint, cardLabel } from '@agentdock/shared';
import type { LocalMethodArgs } from '@agentdock/shared/protocol';
import { Injectable, Logger } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../database/prisma.service';
import { BoardService } from './board.service';
import { BOARD_SYSTEM_ACTOR, type BoardActor, BoardWork } from './board-work';

/** The web app's origin for a card's link (`APP_URL`, else `WEB_URL`). */
const webOrigin = (env: NodeJS.ProcessEnv = process.env): string =>
  (env.APP_URL || env.WEB_URL || 'http://localhost:3517').replace(/\/+$/, '');

/** What `card.track` answers (#282 D1). */
export interface TrackedCardRef {
  number: number;
  label: string;
  url: string;
}

/** The asking runner's project, as the local router verified it. */
interface TrackProject {
  id: string;
  runnerId: string;
}

/** Why `track` refused: the session is not a person's own manual one. */
export class NotAManualSession extends Error {}

/**
 * Terminal work on the Board (issue #282 D1–D3, ADR-0030 §1–§3): the card a
 * person's own Claude Code session tracks with `track_card`. It starts no
 * worker; it moves to Finished when its session ends or calls
 * `finish_card`, and only a person moves it to Completed. Whether Finished
 * collects — `autoCollect` — is `BoardWork`'s move rule.
 */
@Injectable()
export class BoardTerminalService {
  private readonly logger = new Logger(BoardTerminalService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly work: BoardWork,
    private readonly board: BoardService,
    private readonly auditLog: AuditService,
  ) {}

  /**
   * `card.track`: the first call of a session creates card C-n In progress,
   * `source: terminal`, linked to the session; a later call updates that
   * card's title and body (and kind, when given). `sessionId` is Claude's own
   * id, resolved on the asking runner; any session that is not `manual` in
   * this project throws `NotAManualSession`.
   */
  async track(
    project: TrackProject,
    sessionId: string,
    args: LocalMethodArgs<'card.track'>,
    actor: BoardActor,
  ): Promise<TrackedCardRef> {
    const session = await this.prisma.agentSession.findUnique({
      where: {
        runnerId_runtime_externalId: {
          runnerId: project.runnerId,
          runtime: 'claude',
          externalId: sessionId,
        },
      },
      select: { id: true, origin: true, projectId: true },
    });
    if (
      !session ||
      session.origin !== 'manual' ||
      session.projectId !== project.id
    ) {
      throw new NotAManualSession();
    }
    const title = args.title.trim();
    const body = args.body;
    const now = new Date();
    const outcome = await this.prisma.$transaction(async (tx) => {
      // One card per session (the unique `trackedSessionId`), even when two
      // calls race: the second waits here and finds the first one's card.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`board-track:${session.id}`}))`;
      const existing = await tx.boardCard.findUnique({
        where: { trackedSessionId: session.id },
      });
      if (existing) {
        const card = await tx.boardCard.update({
          where: { id: existing.id },
          data: {
            title,
            fingerprint: captureFingerprint(title),
            ...(body !== undefined ? { body } : {}),
            ...(args.kind !== undefined
              ? { kind: args.kind, kindSource: 'person' as const }
              : {}),
          },
        });
        return { card, before: existing };
      }
      const settings = await tx.boardSettings.findUnique({
        where: { projectId: project.id },
        select: { autoCollectTracked: true },
      });
      const next = await this.work.nextCard(tx, project.id);
      const position = await this.work.place(
        tx,
        { id: '', projectId: project.id },
        'in_progress',
        0,
      );
      const card = await tx.boardCard.create({
        data: {
          projectId: project.id,
          ...next,
          title,
          fingerprint: captureFingerprint(title),
          body: body ?? '',
          // #271 D9: without a kind the model classifies it.
          kind: args.kind ?? 'feature',
          kindSource: args.kind === undefined ? 'auto' : 'person',
          column: 'in_progress',
          position,
          source: 'terminal',
          trackedSessionId: session.id,
          autoCollect: settings?.autoCollectTracked ?? false,
          issueOnRun: false,
          specOnRun: false,
          createdById: actor.userId,
          movedById: actor.userId,
          movedAt: now,
        },
      });
      return { card, before: null };
    });
    const { card, before } = outcome;
    await this.audit(actor, card.id, project.id, before === null, {
      number: card.number,
      title: card.title,
      kind: card.kind,
      source: 'terminal',
      sessionId: session.id,
      ...(before === null ? { autoCollect: card.autoCollect } : {}),
    });
    this.work.publish(project.id, card.id);
    const changed = {
      ...(before === null || before.title !== card.title
        ? { title: card.title }
        : {}),
      ...(before === null || before.body !== card.body
        ? { body: card.body }
        : {}),
    };
    if (Object.keys(changed).length > 0) {
      await this.board.normalizeCard(card, changed, actor);
    }
    return {
      number: card.number,
      label: cardLabel(card.number),
      url: `${webOrigin()}/projects/${project.id}/board?card=${card.number}`,
    };
  }

  /**
   * D2: `finish_card` from the tracked session — its card moves to Finished.
   * `null` when the session tracks no card of this project.
   */
  async finishBySession(
    project: TrackProject,
    sessionId: string,
  ): Promise<{ number: number } | null> {
    const card = await this.prisma.boardCard.findFirst({
      where: {
        projectId: project.id,
        source: 'terminal',
        project: { runnerId: project.runnerId },
        trackedSession: {
          runnerId: project.runnerId,
          runtime: 'claude',
          externalId: sessionId,
        },
      },
      select: { number: true },
    });
    if (!card) return null;
    await this.toFinished(project.id, card.number);
    return { number: card.number };
  }

  /**
   * D2: the tracked session ended (the `SessionEnd` hook) — its card moves to
   * Finished, once. A card a person already moved elsewhere stays there.
   */
  async sessionEnded(runnerId: string, sessionId: string): Promise<void> {
    const card = await this.prisma.boardCard.findFirst({
      where: {
        source: 'terminal',
        project: { runnerId },
        trackedSession: { runnerId, runtime: 'claude', externalId: sessionId },
      },
      select: { projectId: true, number: true },
    });
    if (card) await this.toFinished(card.projectId, card.number);
  }

  /** In progress → Finished, as the board's own automatic move. */
  private async toFinished(projectId: string, number: number): Promise<void> {
    try {
      const project = await this.work.project(projectId);
      const card = await this.work.card(projectId, number);
      if (card.column !== 'in_progress') return;
      await this.work.move(
        project,
        card,
        { to: 'finished', index: 0, source: 'automatic' },
        BOARD_SYSTEM_ACTOR,
      );
    } catch (error) {
      // A refused or vanished card is not the caller's failure.
      this.logger.warn(
        `tracked card ${projectId}#${number} not moved to Finished: ${(error as Error).message}`,
      );
    }
  }

  private async audit(
    actor: BoardActor,
    cardId: string,
    projectId: string,
    created: boolean,
    after: Record<string, unknown>,
  ): Promise<void> {
    await this.auditLog.record({
      ...actor.ctx,
      action: created ? 'card.created' : 'card.updated',
      target: { type: 'board_card', id: cardId },
      projectId,
      after,
      result: 'ok',
    });
  }
}

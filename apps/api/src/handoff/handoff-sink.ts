import {
  type HandoffSubject,
  type HandoffUpdatedData,
  handoffEventDataSchemas,
  handoffPersonLinesSchema,
  isHandoffEventType,
  ROUND_RESTART_EVENT,
  ROUND_WARMUP_EVENT,
  type RoundRestartData,
  type RoundWarmupData,
} from '@nautelle/shared';
import type { RunnerEvent } from '@nautelle/shared/protocol';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { BoardWork } from '../board/board-work';
import { PrismaService } from '../database/prisma.service';
import {
  type RunnerEventSink,
  RunnerEventSinks,
} from '../runners/runner-event-sinks';
import { applyNoteUpdate, type StoredNote } from './handoff-content';

/** D1: the runs that keep a note — design (`uiprofile`) and planner turns. */
const NOTE_RUN_KINDS = ['ui_profile', 'plan'] as const;

/** A note's subject as this runner owns it: the row, never the event, names the project. */
interface ResolvedSubject {
  kind: 'card' | 'run';
  id: string;
  projectId: string;
  shipContent: boolean;
}

/** A stored note row as an update reads it; `null` personLines that do not parse. */
export const storedNoteOf = (row: {
  content: string;
  personLines: Prisma.JsonValue;
  updatedBy: StoredNote['updatedBy'];
}): StoredNote | null => {
  const personLines = handoffPersonLinesSchema.safeParse(row.personLines);
  return personLines.success
    ? {
        content: row.content,
        personLines: personLines.data,
        updatedBy: row.updatedBy,
      }
    : null;
};

/**
 * Sink `handoff` (#449, ADR-0042): the API's copy of a card's or a run's
 * handoff note (`handoff.updated`, only for a project with session content
 * on — ADR-0021, D4) and a card round's restart decision and warm-up
 * (`round.restart`, `round.warmup`).
 *
 * DA-04: only `source: runner` events count — the runner's own, never a
 * Code Sentinel line relayed with another source. The card, the run and the
 * round are looked up on this runner's projects; their row names the
 * project, and an event whose `projectId` or `cardId` disagrees is skipped.
 * DA-05: the note's person lines are the API's (`applyNoteUpdate`).
 * DA-12: the ingest strips the note from `events.data` after this sink ran
 * (`stripHandoffContent`). Every write is idempotent: a replay changes nothing.
 */
@Injectable()
export class HandoffSink implements RunnerEventSink, OnModuleInit {
  readonly name = 'handoff';
  private readonly logger = new Logger(HandoffSink.name);

  constructor(
    private readonly sinks: RunnerEventSinks,
    private readonly prisma: PrismaService,
    private readonly work: BoardWork,
  ) {}

  onModuleInit(): void {
    this.sinks.register(this);
  }

  async handle(runnerId: string, events: RunnerEvent[]): Promise<void> {
    for (const event of events) {
      if (!isHandoffEventType(event.type)) continue;
      if (event.source !== 'runner') {
        this.logger.warn(
          `runner ${runnerId}: ${event.type} from ${event.source} (seq ${event.seq}), skipped`,
        );
        continue;
      }
      const parsed = handoffEventDataSchemas[event.type].safeParse(event.data);
      if (!parsed.success) {
        this.logger.warn(
          `runner ${runnerId}: malformed ${event.type} (seq ${event.seq}), skipped`,
        );
        continue;
      }
      if (event.type === ROUND_RESTART_EVENT) {
        await this.restart(runnerId, parsed.data as RoundRestartData);
      } else if (event.type === ROUND_WARMUP_EVENT) {
        await this.warmup(runnerId, parsed.data as RoundWarmupData);
      } else {
        await this.noteUpdated(runnerId, parsed.data as HandoffUpdatedData);
      }
    }
  }

  private async subjectOf(
    runnerId: string,
    subject: HandoffSubject,
  ): Promise<ResolvedSubject | null> {
    const project = { select: { shipSessionContent: true } } as const;
    if (subject.kind === 'card') {
      const card = await this.prisma.boardCard.findFirst({
        where: { id: subject.cardId, project: { runnerId } },
        select: { id: true, projectId: true, project },
      });
      return card
        ? {
            kind: 'card',
            id: card.id,
            projectId: card.projectId,
            shipContent: card.project.shipSessionContent,
          }
        : null;
    }
    const run = await this.prisma.run.findFirst({
      where: {
        id: subject.runId,
        kind: { in: [...NOTE_RUN_KINDS] },
        project: { runnerId },
      },
      select: { id: true, projectId: true, project },
    });
    return run
      ? {
          kind: 'run',
          id: run.id,
          projectId: run.projectId,
          shipContent: run.project.shipSessionContent,
        }
      : null;
  }

  private async noteUpdated(
    runnerId: string,
    data: HandoffUpdatedData,
  ): Promise<void> {
    const subject = await this.subjectOf(runnerId, data.subject);
    if (!subject || subject.projectId !== data.projectId) {
      this.logger.warn(
        `runner ${runnerId}: handoff.updated for unknown ${data.subject.kind}, skipped`,
      );
      return;
    }
    // D4, ADR-0021: a project that keeps content on the machine has no copy.
    if (!subject.shipContent) return;

    const key = { subjectKind: subject.kind, subjectId: subject.id };
    const row = await this.prisma.handoffNote.findUnique({
      where: { subjectKind_subjectId: key },
      select: { content: true, personLines: true, updatedBy: true },
    });
    const stored = row ? storedNoteOf(row) : null;
    if (row && !stored) {
      this.logger.error(
        `handoff note ${subject.kind} ${subject.id}: stored person lines do not parse, update skipped`,
      );
      return;
    }
    const update = applyNoteUpdate(stored, data);
    if (update.kind === 'unchanged') return;
    if (update.kind === 'refused') {
      this.logger.warn(
        `runner ${runnerId}: handoff.updated for ${subject.kind} ${subject.id} drops ${update.missing.length} person line(s), kept the copy`,
      );
      return;
    }
    const fields = {
      content: update.content,
      personLines: update.personLines as Prisma.InputJsonValue,
      updatedBy: update.updatedBy,
    };
    await this.prisma.handoffNote.upsert({
      where: { subjectKind_subjectId: key },
      create: { ...key, projectId: subject.projectId, ...fields },
      update: fields,
    });
    if (subject.kind === 'card') {
      this.work.publish(subject.projectId, subject.id);
    }
  }

  /** The round of `runId` on this runner, if its card is the event's. */
  private async roundOf(
    runnerId: string,
    data: Pick<RoundRestartData, 'runId' | 'cardId' | 'projectId'>,
    type: string,
  ) {
    const round = await this.prisma.boardCardRound.findFirst({
      where: { runId: data.runId, card: { project: { runnerId } } },
      select: {
        id: true,
        round: true,
        cardId: true,
        card: { select: { projectId: true } },
      },
    });
    if (
      !round ||
      round.cardId !== data.cardId ||
      round.card.projectId !== data.projectId
    ) {
      this.logger.warn(
        `runner ${runnerId}: ${type} for unknown card round ${data.runId}, skipped`,
      );
      return null;
    }
    return round;
  }

  /**
   * D3: the round records how its session started. A `fresh` start moves the
   * card to the new session — only from the session it replaced, so a
   * replay or a late event never moves it back — and leaves the replaced
   * session on the round before, so it can still be resumed.
   */
  private async restart(
    runnerId: string,
    data: RoundRestartData,
  ): Promise<void> {
    const round = await this.roundOf(runnerId, data, ROUND_RESTART_EVENT);
    if (!round) return;
    await this.prisma.$transaction(async (tx) => {
      await tx.boardCardRound.update({
        where: { id: round.id },
        data: {
          restartMode: data.mode,
          restartEstimate:
            data.estimate === null
              ? Prisma.DbNull
              : (data.estimate as Prisma.InputJsonValue),
          sessionId: data.sessionId,
        },
      });
      if (data.mode !== 'fresh' || data.previousSessionId === undefined) {
        return;
      }
      await tx.boardCard.updateMany({
        where: { id: round.cardId, sessionId: data.previousSessionId },
        data: { sessionId: data.sessionId },
      });
      const earlier = await tx.boardCardRound.findFirst({
        where: { cardId: round.cardId, round: { lt: round.round } },
        orderBy: { round: 'desc' },
        select: { id: true },
      });
      if (earlier) {
        await tx.boardCardRound.updateMany({
          where: { id: earlier.id, sessionId: null },
          data: { sessionId: data.previousSessionId },
        });
      }
    });
    this.work.publish(round.card.projectId, round.cardId);
  }

  /** D9: tokens and ms to the round's first file edit. */
  private async warmup(runnerId: string, data: RoundWarmupData): Promise<void> {
    const round = await this.roundOf(runnerId, data, ROUND_WARMUP_EVENT);
    if (!round) return;
    await this.prisma.boardCardRound.update({
      where: { id: round.id },
      data: { warmupTokens: data.tokens, warmupMs: data.ms },
    });
    this.work.publish(round.card.projectId, round.cardId);
  }
}

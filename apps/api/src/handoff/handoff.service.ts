import {
  BOARD_ERROR,
  type CardHandoffView,
  cardLabel,
  type HandoffRejection,
  markPersonEdit,
  validateHandoffNote,
} from '@nautelle/shared';
import {
  capabilitiesSchema,
  handoffAvailable,
} from '@nautelle/shared/protocol';
import {
  BadGatewayException,
  ConflictException,
  Injectable,
  Logger,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { HandoffNote, Prisma, Role } from '@prisma/client';
import type { AuditContext } from '../audit/audit.types';
import { BoardFailure, cardNotFound } from '../board/board-error';
import { BoardWork } from '../board/board-work';
import { PrismaService } from '../database/prisma.service';
import { RunnerCommandService } from '../runners/runner-command.service';
import { RunnerPresence } from '../runners/runner-presence';
import { unmarked } from './handoff-content';
import { storedNoteOf } from './handoff-sink';

/** Who edits a note: the caller's role on the project, and the audit context. */
export interface HandoffActor {
  role: Role;
  ctx: AuditContext;
}

const NOTE_SELECT = {
  content: true,
  personLines: true,
  updatedBy: true,
  updatedAt: true,
} as const satisfies Prisma.HandoffNoteSelect;

type NoteRow = Pick<HandoffNote, keyof typeof NOTE_SELECT>;

const viewOf = (row: NoteRow | null): CardHandoffView['note'] => {
  const note = row ? storedNoteOf(row) : null;
  return row && note
    ? {
        content: note.content,
        personLines: note.personLines,
        updatedBy: note.updatedBy,
        updatedAt: row.updatedAt.toISOString(),
      }
    : null;
};

/**
 * A card's handoff note in the card sheet (#449 D7, ADR-0042): read by any
 * member (D-03), edited by an operator. The API holds a copy only while the
 * project ships session content (ADR-0021); the note itself lives in the
 * card's worktree, and a person's edit reaches it as `card.handoff.set`.
 */
@Injectable()
export class HandoffService {
  private readonly logger = new Logger(HandoffService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly commands: RunnerCommandService,
    private readonly presence: RunnerPresence,
    private readonly work: BoardWork,
  ) {}

  /** `GET /projects/:id/board/cards/:number/handoff`. */
  async view(projectId: string, number: number): Promise<CardHandoffView> {
    const card = await this.cardOf(projectId, number);
    if (!card.project.shipSessionContent) {
      return { shipContent: false, note: null };
    }
    return { shipContent: true, note: viewOf(await this.rowOf(card.id)) };
  }

  /**
   * `PUT /projects/:id/board/cards/:number/handoff`. The person's lines are
   * marked here against the copy the API holds (DA-05: the API's ranges are
   * the only record of them; marks in the text are dropped). The copy is
   * stored before the command goes out, so the runner's `handoff.updated`
   * echo finds it; a command that does not apply puts the copy back.
   */
  async put(
    projectId: string,
    number: number,
    content: string,
    actor: HandoffActor,
  ): Promise<CardHandoffView> {
    const card = await this.cardOf(projectId, number);
    if (!card.project.shipSessionContent) {
      throw new ConflictException(
        'The project keeps session content on the machine, so the API holds no note to edit',
      );
    }
    const edited = unmarked(content.replace(/\r\n?/g, '\n'));
    const validation = validateHandoffNote(edited);
    if (!validation.ok) throw this.invalid(validation.reasons);
    this.assertServes(card.project.runnerId, card.project.runner.capabilities);

    const key = { subjectKind: 'card' as const, subjectId: card.id };
    const prevRow = await this.rowOf(card.id);
    const prev = prevRow ? storedNoteOf(prevRow) : null;
    if (prevRow && !prev) {
      this.logger.error(
        `handoff note of card ${card.id}: stored person lines do not parse; the edit marks every changed line`,
      );
    }
    if (prev?.content === edited) {
      return { shipContent: true, note: viewOf(prevRow) };
    }
    const personLines = markPersonEdit(
      prev?.content ?? '',
      prev?.personLines ?? [],
      edited,
    );
    const fields = {
      content: edited,
      personLines: personLines as Prisma.InputJsonValue,
      updatedBy: 'person' as const,
    };
    const stored = await this.prisma.handoffNote.upsert({
      where: { subjectKind_subjectId: key },
      create: { ...key, projectId, ...fields },
      update: fields,
      select: NOTE_SELECT,
    });

    const result = await this.commands.send(
      card.project.runnerId,
      'card.handoff.set',
      {
        projectId,
        cardId: card.id,
        shortId: card.shortId,
        content: edited,
        personLines,
      },
      {
        role: actor.role,
        ctx: actor.ctx,
        // DA-12: the audit log holds the edit's shape, never its text.
        auditArgs: {
          projectId,
          cardId: card.id,
          shortId: card.shortId,
          lines: edited.split('\n').length,
          personLines,
        },
      },
    );
    if (result.status === 'ok' && result.output.outcome === 'applied') {
      this.work.publish(projectId, card.id);
      return { shipContent: true, note: viewOf(stored) };
    }

    // Not applied: the copy goes back to what the machine still holds —
    // unless something newer replaced it meanwhile.
    const unchangedSince = { ...key, updatedAt: stored.updatedAt };
    if (prevRow) {
      await this.prisma.handoffNote.updateMany({
        where: unchangedSince,
        data: {
          content: prevRow.content,
          personLines: prevRow.personLines as Prisma.InputJsonValue,
          updatedBy: prevRow.updatedBy,
        },
      });
    } else {
      await this.prisma.handoffNote.deleteMany({ where: unchangedSince });
    }
    if (result.status === 'ok') {
      throw new ConflictException(
        `${cardLabel(number)} has no worktree on the machine yet; its first round writes the note`,
      );
    }
    if (result.status === 'error') {
      throw new BadGatewayException(
        `The runner did not apply the note: ${result.error.message ?? result.error.code}`,
      );
    }
    throw new BoardFailure(
      503,
      BOARD_ERROR.commandUnavailable,
      'The runner did not answer; the note was not changed',
    );
  }

  private async cardOf(projectId: string, number: number) {
    const card = await this.prisma.boardCard.findUnique({
      where: { projectId_number: { projectId, number } },
      select: {
        id: true,
        shortId: true,
        project: {
          select: {
            shipSessionContent: true,
            runnerId: true,
            runner: { select: { capabilities: true } },
          },
        },
      },
    });
    if (!card) throw cardNotFound();
    return card;
  }

  private rowOf(cardId: string): Promise<NoteRow | null> {
    return this.prisma.handoffNote.findUnique({
      where: {
        subjectKind_subjectId: { subjectKind: 'card', subjectId: cardId },
      },
      select: NOTE_SELECT,
    });
  }

  /** 503 `command_unavailable` unless the runner is up and serves `card.handoff.set`. */
  private assertServes(runnerId: string, stored: Prisma.JsonValue): void {
    const capabilities = capabilitiesSchema.safeParse(stored);
    if (!capabilities.success || !handoffAvailable(capabilities.data)) {
      throw new BoardFailure(
        503,
        BOARD_ERROR.commandUnavailable,
        'The runner does not keep handoff notes; update it',
      );
    }
    if (!this.presence.isConnected(runnerId)) {
      throw new BoardFailure(
        503,
        BOARD_ERROR.commandUnavailable,
        'The runner is not connected',
      );
    }
    if (this.presence.missingCommand(runnerId, ['card.handoff.set'])) {
      throw new BoardFailure(
        503,
        BOARD_ERROR.commandUnavailable,
        'The runner does not serve card.handoff.set; update it',
      );
    }
  }

  /** 422 with every reason, so one rewrite fixes them all (D5). */
  private invalid(reasons: HandoffRejection[]): UnprocessableEntityException {
    return new UnprocessableEntityException({
      statusCode: 422,
      error: 'invalid_note',
      message: reasons.map((r) => r.message).join('; '),
      reasons,
    });
  }
}

import {
  isActiveRoundPhase,
  SESSION_MESSAGE_ERROR,
  type SessionMessageInput,
  type SessionMessageVia,
  type SessionMessageView,
} from '@nautelle/shared';
import { Injectable } from '@nestjs/common';
import {
  SessionMessageService,
  sessionMessageError,
} from '../session-message/session-message.service';
import { type BoardActor, BoardWork } from './board-work';

/**
 * #489 M1–M4: a person's message to the running round of a card — text the
 * agent reads at its next step (queued while it works), or the answer to
 * the question selector its session shows. Operators and admins, as card
 * feedback; the route's role check answers a viewer 403 first.
 */
@Injectable()
export class BoardSessionMessages {
  constructor(
    private readonly work: BoardWork,
    private readonly messages: SessionMessageService,
  ) {}

  async message(
    projectId: string,
    number: number,
    input: SessionMessageInput,
    actor: BoardActor,
    via: SessionMessageVia = 'web',
  ): Promise<SessionMessageView> {
    const card = await this.work.card(projectId, number);
    const round = card.rounds[0];
    if (!round || !isActiveRoundPhase(round.phase)) {
      throw sessionMessageError(
        409,
        SESSION_MESSAGE_ERROR.notRunning,
        `C-${card.number} has no running round`,
      );
    }
    const project = await this.work.project(projectId);
    return this.messages.send({
      projectId,
      runnerId: project.runnerId,
      target: { kind: 'card_round', cardId: card.id, runId: round.runId },
      input,
      role: actor.role,
      ctx: actor.ctx,
      via,
    });
  }
}

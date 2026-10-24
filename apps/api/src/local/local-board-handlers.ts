import { sessionMessageInputSchema } from '@nautelle/shared';
import type { LocalMethodName } from '@nautelle/shared/protocol';
import { Injectable } from '@nestjs/common';
import { BoardService } from '../board/board.service';
import { BoardRoundsService } from '../board/board-rounds.service';
import {
  BoardSessionService,
  type SessionBoardProject,
} from '../board/board-session.service';
import { BoardSessionMessages } from '../board/board-session-message.service';
import type { ManualSession } from '../board/board-terminal.service';
import { BoardWaitService } from '../board/board-wait.service';
import type { BoardActor } from '../board/board-work';
import {
  type LocalCall,
  type LocalHandlerTable,
  projectOf,
} from './local-call';
import { LocalError } from './local-error';
import { LocalManualGate } from './local-manual-gate';

/** The Board methods a person's session works the Board with (#845). */
export type LocalBoardMethod = Extract<
  LocalMethodName,
  | 'board.list'
  | 'board.card'
  | 'board.wait'
  | 'card.create'
  | 'card.run'
  | 'card.move'
  | 'card.feedback'
  | 'card.message'
  | 'card.stop'
  | 'card.take'
  | 'card.release'
>;

/** `card.move` without an `index`: the bottom (the board clamps it). */
const BOTTOM = 1_000_000;

export const actorOf = (call: LocalCall): BoardActor => ({
  userId: call.user.id,
  role: call.role,
  ctx: call.ctx,
});

const sessionProjectOf = (call: LocalCall): SessionBoardProject => {
  const project = projectOf(call);
  return { id: project.id, runnerId: call.runnerId, repo: project.repo };
};

/**
 * #845 (ADR-0083): the Board from a person's session. Reads answer any
 * session of the project; control answers only a `manual` one (§2) and acts
 * through the Board's own services as the runner's local user, so the
 * Board's refusals come back by name (§9). Completed is a person's (§3).
 */
@Injectable()
export class LocalBoardHandlers {
  constructor(
    private readonly board: BoardService,
    private readonly rounds: BoardRoundsService,
    private readonly messages: BoardSessionMessages,
    private readonly sessions: BoardSessionService,
    private readonly gate: LocalManualGate,
    private readonly waits: BoardWaitService,
  ) {}

  readonly table: Pick<LocalHandlerTable, LocalBoardMethod> = {
    'board.list': (args, call) =>
      this.sessions.list(projectOf(call).id, call.role, args.column),
    'board.card': (args, call) =>
      this.sessions.card(projectOf(call).id, args.card, call.role),
    'board.wait': (args, call) =>
      this.waits.wait(projectOf(call).id, call.role, args),
    'card.create': (args, call) =>
      this.control(call, (session) =>
        this.sessions.create(projectOf(call).id, session, args, actorOf(call)),
      ),
    'card.run': (args, call) =>
      this.control(call, async () => {
        const card = await this.rounds.run(
          projectOf(call).id,
          args.card,
          { model: args.model, effort: args.effort },
          actorOf(call),
        );
        return { number: card.number, round: this.roundOf(card) };
      }),
    'card.move': (args, call) =>
      this.control(call, async () => {
        if (args.column === 'completed') {
          throw new LocalError(
            'completed_needs_person',
            'Only a person accepts a card: file request_action card_accept',
          );
        }
        const card = await this.board.move(
          projectOf(call).id,
          args.card,
          { column: args.column, index: args.index ?? BOTTOM },
          actorOf(call),
        );
        return { number: card.number, column: card.column };
      }),
    'card.feedback': (args, call) =>
      this.control(call, async () => {
        const card = await this.rounds.feedback(
          projectOf(call).id,
          args.card,
          { text: args.text },
          actorOf(call),
        );
        return { number: card.number, round: this.roundOf(card) };
      }),
    'card.message': (args, call) =>
      this.control(call, async () => {
        const { card, ...input } = args;
        const view = await this.messages.message(
          projectOf(call).id,
          card,
          sessionMessageInputSchema.parse(input),
          actorOf(call),
        );
        return { outcome: view.outcome };
      }),
    'card.stop': (args, call) =>
      this.control(call, async () => {
        const card = await this.board.stop(
          projectOf(call).id,
          args.card,
          actorOf(call),
        );
        return { number: card.number, stopped: true as const };
      }),
    'card.take': (args, call) =>
      this.control(call, (session) =>
        this.sessions.take(
          sessionProjectOf(call),
          session,
          args.card,
          actorOf(call),
        ),
      ),
    'card.release': (args, call) =>
      this.control(call, (session) =>
        this.sessions.release(
          sessionProjectOf(call),
          session,
          args.card,
          actorOf(call),
        ),
      ),
  };

  /** §2: a control tool answers only a person's own `manual` session. */
  private control<T>(
    call: LocalCall,
    work: (session: ManualSession) => Promise<T>,
  ): Promise<T> {
    return this.gate.control(call, work);
  }

  /** The round a Run or feedback just started. */
  private roundOf(card: { round: { round: number } | null }): number {
    if (!card.round) throw new LocalError('internal', 'no round started');
    return card.round.round;
  }
}

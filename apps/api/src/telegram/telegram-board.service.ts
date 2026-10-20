import {
  type BoardCardDetail,
  type BoardColumn,
  type BoardView,
  COLUMN_TITLE,
  canRetry,
  canRun,
  canStop,
  cardReviewActions,
  type Role,
} from '@agentdock/shared';
import { HttpException, Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../audit';
import { ANONYMOUS_ACTOR, userActor } from '../audit/audit.types';
import { BoardService } from '../board/board.service';
import { BoardRoundsService } from '../board/board-rounds.service';
import type { BoardActor } from '../board/board-work';
import { PrismaService } from '../database/prisma.service';
import { httpErrorBody } from '../local/local-error';
import {
  BOARD_CALLBACK_PREFIXES,
  BOARD_REPLIES,
  BOARD_VIEW_CALLBACK,
  boardFailureText,
  boardKeyboard,
  boardText,
  CARD_CALLBACK,
  COLUMN_CALLBACK,
  type ColumnCount,
  cardKeyboard,
  cardMissingText,
  cardText,
  clip,
  columnKeyboard,
  columnText,
  MOVE_CALLBACK,
  MOVE_PICK_CALLBACK,
  movePickKeyboard,
  movePickText,
  pageCount,
  parseCardNumber,
  parseColumn,
  RUN_CALLBACK,
  STOP_ASK_CALLBACK,
  STOP_CALLBACK,
  stopAskKeyboard,
  stopAskText,
} from './board-actions';
import { reviewKeyboard } from './card-actions';
import type { InlineKeyboard, TelegramCallbackQuery } from './telegram-client';
import { type GuardRefusal, TelegramGuard } from './telegram-guard.service';
import { LINK_REPLIES } from './telegram-linking.service';
import { TELEGRAM_OPTIONS, type TelegramOptions } from './telegram-options';
import {
  boardReply,
  projectRefusalText,
  TelegramProjectService,
} from './telegram-project.service';
import type { CommandContext, TelegramAnswer } from './telegram-router';

export { BOARD_CALLBACK_PREFIXES };

const NOTICE_MAX = 190;

const GUARD_TEXT: Record<GuardRefusal, string> = {
  not_linked: LINK_REPLIES.notLinked,
  inactive_user: 'Your Nautelle account is not active.',
  not_member: 'You are not a member of this project any more.',
  role: BOARD_REPLIES.roleDenied,
};

type WriteAction = 'move' | 'run' | 'stop';

/** Where a Board message is shown: the chat, and the message to rewrite. */
interface Screen {
  chatId: number;
  editMessageId?: number;
  callbackQueryId?: string;
}

interface Scope {
  projectId: string;
  /** The project's name, for the first line of every reply. */
  displayName: string;
  role: Role;
  actor: BoardActor;
}

type Reached =
  | { ok: true; scope: Scope }
  | {
      ok: false;
      text: string;
      /** Who was refused; null for an unlinked chat. */
      userId: string | null;
      projectId: string;
    };

/**
 * #576: the Board in Telegram — `/board`, `/card <n>` and the buttons of
 * their messages. Reads need any active member, Move, Run and Stop an
 * operator, checked from scratch on every press through `TelegramGuard`:
 * a forged write button from a viewer is refused here, not just hidden. The
 * actions are the Board's own services, called as the linked user, so their
 * rules, errors and audit rows are the web's; each attempt also writes one
 * `telegram.board` row with `meta.via = "telegram"` (ADR-0046 D7). After an
 * action the card's message is rewritten in place. A writer's card message
 * also carries the card's review actions (#578, `TelegramCardService`).
 */
@Injectable()
export class TelegramBoardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly guard: TelegramGuard,
    private readonly projects: TelegramProjectService,
    private readonly board: BoardService,
    private readonly rounds: BoardRoundsService,
    private readonly audit: AuditService,
    @Inject(TELEGRAM_OPTIONS) private readonly options: TelegramOptions,
  ) {}

  /** `/board` and `/board <column>`. */
  async handleBoardCommand(context: CommandContext): Promise<TelegramAnswer> {
    const screen = { chatId: context.chatId };
    if (!context.isPrivate) return this.text(screen, LINK_REPLIES.notPrivate);
    const current = await this.projects.current(context.chatId, 'read');
    if (!current.ok) {
      return this.text(screen, projectRefusalText(current.reason));
    }
    const scope = this.scopeOf(current.project, current.user.id);
    if (!context.args) return this.boardView(screen, scope);
    const column = parseColumn(context.args);
    const view = column ? await this.view(scope) : null;
    if (!column || !view?.columns.some((c) => c.column === column)) {
      return this.text(screen, boardReply(scope, BOARD_REPLIES.noColumn));
    }
    return this.columnView(screen, scope, view, column, 0);
  }

  /** `/card <n>`. */
  async handleCardCommand(context: CommandContext): Promise<TelegramAnswer> {
    const screen = { chatId: context.chatId };
    if (!context.isPrivate) return this.text(screen, LINK_REPLIES.notPrivate);
    const current = await this.projects.current(context.chatId, 'read');
    if (!current.ok) {
      return this.text(screen, projectRefusalText(current.reason));
    }
    const scope = this.scopeOf(current.project, current.user.id);
    const number = parseCardNumber(context.args);
    if (number === null) {
      return this.text(screen, boardReply(scope, BOARD_REPLIES.cardUsage));
    }
    return this.cardView(screen, scope, number);
  }

  /** A press on a button of a Board message. */
  async handleCallback(query: TelegramCallbackQuery): Promise<TelegramAnswer> {
    const chat = query.message?.chat;
    const chatId = chat?.id ?? query.from.id;
    const screen: Screen = {
      chatId,
      callbackQueryId: query.id,
      editMessageId: query.message?.message_id,
    };
    if (chat && chat.type !== 'private') {
      return this.text(screen, BOARD_REPLIES.invalidButton);
    }
    const data = query.data;

    const list = COLUMN_CALLBACK.decode(data);
    if (list) {
      const reached = await this.reach(chatId, list.project, 'read');
      if (!reached.ok) return this.text(screen, reached.text);
      const view = await this.view(reached.scope);
      return this.columnView(
        screen,
        reached.scope,
        view,
        list.column,
        list.page,
      );
    }
    const overview = BOARD_VIEW_CALLBACK.decode(data);
    if (overview) {
      const reached = await this.reach(chatId, overview.project, 'read');
      return reached.ok
        ? this.boardView(screen, reached.scope)
        : this.text(screen, reached.text);
    }
    const open = CARD_CALLBACK.decode(data);
    if (open) {
      const reached = await this.reach(chatId, open.project, 'read');
      return reached.ok
        ? this.cardView(screen, reached.scope, open.number)
        : this.text(screen, reached.text);
    }
    const pick = MOVE_PICK_CALLBACK.decode(data);
    if (pick) return this.movePick(screen, pick.project, pick.number);
    const move = MOVE_CALLBACK.decode(data);
    if (move) {
      return this.act(screen, 'move', move.project, move.number, move.column);
    }
    const run = RUN_CALLBACK.decode(data);
    if (run) return this.act(screen, 'run', run.project, run.number);
    const ask = STOP_ASK_CALLBACK.decode(data);
    if (ask) return this.stopAsk(screen, ask.project, ask.number);
    const stop = STOP_CALLBACK.decode(data);
    if (stop) return this.act(screen, 'stop', stop.project, stop.number);
    return this.text(screen, BOARD_REPLIES.invalidButton);
  }

  // ─── Screens ───────────────────────────────────────────────────────────────

  private async boardView(
    screen: Screen,
    scope: Scope,
  ): Promise<TelegramAnswer> {
    const view = await this.view(scope);
    const counts: ColumnCount[] = view.columns.map((c) => ({
      column: c.column,
      count: c.cards.length,
      more: c.hasMore,
    }));
    return this.show(
      screen,
      boardReply(scope, boardText(counts)),
      boardKeyboard(scope.projectId, counts),
    );
  }

  private async columnView(
    screen: Screen,
    scope: Scope,
    view: BoardView,
    column: BoardColumn,
    page: number,
  ): Promise<TelegramAnswer> {
    const entry = view.columns.find((c) => c.column === column);
    if (!entry) return this.text(screen, BOARD_REPLIES.invalidButton);
    const at = Math.min(page, pageCount(entry.cards.length) - 1);
    return this.show(
      screen,
      boardReply(scope, columnText(column, entry.cards, at, entry.hasMore)),
      columnKeyboard(scope.projectId, column, entry.cards, at),
    );
  }

  /** The card's detail; `service` is the line an action just wrote. */
  private async cardView(
    screen: Screen,
    scope: Scope,
    number: number,
    service?: string,
  ): Promise<TelegramAnswer> {
    const card = await this.detail(scope, number);
    if (!card) {
      return this.text(screen, boardReply(scope, cardMissingText(number)));
    }
    const canWrite = scope.role !== 'viewer';
    return this.show(
      screen,
      boardReply(scope, cardText(card, service)),
      cardKeyboard(
        scope.projectId,
        card,
        canWrite,
        this.options.appUrl,
        canWrite ? await this.reviewRows(card) : [],
      ),
    );
  }

  /** #578: the review actions the card's state allows, as rows. */
  private async reviewRows(card: BoardCardDetail): Promise<InlineKeyboard> {
    const actions = cardReviewActions(card);
    if (actions.length === 0) return [];
    const row = await this.prisma.boardCard.findUnique({
      where: { id: card.id },
      select: { shortId: true },
    });
    return row ? reviewKeyboard(row.shortId, actions) : [];
  }

  private async movePick(
    screen: Screen,
    projectId: string,
    number: number,
  ): Promise<TelegramAnswer> {
    const reached = await this.reach(screen.chatId, projectId, 'write');
    if (!reached.ok) return this.refused(screen, reached, 'move', number);
    const card = await this.detail(reached.scope, number);
    if (!card) {
      return this.text(
        screen,
        boardReply(reached.scope, cardMissingText(number)),
      );
    }
    return this.show(
      screen,
      boardReply(reached.scope, movePickText(card)),
      movePickKeyboard(projectId, card),
    );
  }

  private async stopAsk(
    screen: Screen,
    projectId: string,
    number: number,
  ): Promise<TelegramAnswer> {
    const reached = await this.reach(screen.chatId, projectId, 'write');
    if (!reached.ok) return this.refused(screen, reached, 'stop', number);
    const card = await this.detail(reached.scope, number);
    if (!card) {
      return this.text(
        screen,
        boardReply(reached.scope, cardMissingText(number)),
      );
    }
    if (!canStop(card)) {
      return this.cardView(
        screen,
        reached.scope,
        number,
        'Nothing to stop: no worker is running on this card.',
      );
    }
    return this.show(
      screen,
      boardReply(reached.scope, stopAskText(card)),
      stopAskKeyboard(projectId, card),
    );
  }

  // ─── Actions ───────────────────────────────────────────────────────────────

  /** Move, Run or Stop, as the linked operator; then the card, rewritten. */
  private async act(
    screen: Screen,
    action: WriteAction,
    projectId: string,
    number: number,
    column?: BoardColumn,
  ): Promise<TelegramAnswer> {
    const reached = await this.reach(screen.chatId, projectId, 'write');
    if (!reached.ok) return this.refused(screen, reached, action, number);
    const { scope } = reached;
    try {
      const before = await this.detail(scope, number);
      if (!before) {
        return this.text(screen, boardReply(scope, cardMissingText(number)));
      }
      // The buttons were drawn from an older state; the web's rules decide again.
      if (
        (action === 'run' && !(canRun(before) || canRetry(before))) ||
        (action === 'stop' && !canStop(before))
      ) {
        await this.record(scope, action, number, 'error', { reason: 'state' });
        return this.cardView(
          screen,
          scope,
          number,
          action === 'run'
            ? 'Run is not available in this state.'
            : 'Nothing to stop: no worker is running on this card.',
        );
      }
      let service: string;
      if (action === 'move' && column) {
        await this.board.move(
          projectId,
          number,
          { column, index: await this.appendIndex(scope, column) },
          scope.actor,
        );
        service = `Moved to ${COLUMN_TITLE[column]}.`;
      } else if (action === 'run') {
        await this.rounds.run(projectId, number, {}, scope.actor);
        service = 'Run started.';
      } else {
        await this.board.stop(projectId, number, scope.actor);
        service = 'Worker stopped.';
      }
      await this.record(scope, action, number, 'ok', { column });
      return this.cardView(screen, scope, number, `✓ ${service}`);
    } catch (error) {
      if (!(error instanceof HttpException)) throw error;
      const { code, message } = httpErrorBody(error);
      const reason = (error.getResponse() as { reason?: string }).reason;
      const text = boardFailureText(code, reason, message);
      await this.record(scope, action, number, 'error', { code, reason });
      const answer = await this.cardView(
        screen,
        scope,
        number,
        `Nothing changed: ${text}`,
      );
      return { ...answer, notice: clip(text, NOTICE_MAX) };
    }
  }

  /** The drop index at the end of `column`, as a drag to the bottom. */
  private async appendIndex(
    scope: Scope,
    column: BoardColumn,
  ): Promise<number> {
    if (column === 'completed') return 0;
    const view = await this.view(scope);
    return view.columns.find((c) => c.column === column)?.cards.length ?? 0;
  }

  // ─── Reads and checks ──────────────────────────────────────────────────────

  private view(scope: Scope): Promise<BoardView> {
    return this.board.board(scope.projectId, undefined, scope.role);
  }

  /** The card, or null when the project has none (or hides it from the role). */
  private async detail(
    scope: Scope,
    number: number,
  ): Promise<BoardCardDetail | null> {
    try {
      return await this.board.detail(scope.projectId, number, scope.role);
    } catch (error) {
      if (error instanceof HttpException && error.getStatus() === 404) {
        return null;
      }
      throw error;
    }
  }

  /** The button's own project, checked for `need` right now. */
  private async reach(
    chatId: number,
    projectId: string,
    need: 'read' | 'write',
  ): Promise<Reached> {
    const allowed = await this.guard.authorize(chatId, projectId, need);
    if (!allowed.ok) {
      return {
        ok: false,
        text: GUARD_TEXT[allowed.reason],
        userId: allowed.userId,
        projectId,
      };
    }
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { displayName: true },
    });
    if (!project) {
      return {
        ok: false,
        text: GUARD_TEXT.not_member,
        userId: allowed.user.id,
        projectId,
      };
    }
    return {
      ok: true,
      scope: this.scopeOf(
        { id: projectId, displayName: project.displayName, role: allowed.role },
        allowed.user.id,
      ),
    };
  }

  private scopeOf(
    project: { id: string; displayName: string; role: Role },
    userId: string,
  ): Scope {
    return {
      projectId: project.id,
      displayName: project.displayName,
      role: project.role,
      actor: {
        userId,
        role: project.role,
        ctx: { actor: userActor(userId) },
      },
    };
  }

  // ─── Answers and audit ─────────────────────────────────────────────────────

  private text(screen: Screen, text: string): TelegramAnswer {
    return {
      chatId: screen.chatId,
      text,
      ...(screen.callbackQueryId
        ? {
            callbackQueryId: screen.callbackQueryId,
            notice: clip(text, NOTICE_MAX),
          }
        : {}),
    };
  }

  private show(
    screen: Screen,
    text: string,
    keyboard: InlineKeyboard,
  ): TelegramAnswer {
    return {
      chatId: screen.chatId,
      text,
      replyMarkup: { inline_keyboard: keyboard },
      ...(screen.callbackQueryId
        ? { callbackQueryId: screen.callbackQueryId }
        : {}),
      ...(screen.editMessageId !== undefined
        ? { editMessageId: screen.editMessageId }
        : {}),
    };
  }

  /** A write the guard refused: said in a new message, and audited. */
  private async refused(
    screen: Screen,
    reached: Extract<Reached, { ok: false }>,
    action: WriteAction,
    number: number,
  ): Promise<TelegramAnswer> {
    await this.audit.record({
      actor: reached.userId ? userActor(reached.userId) : ANONYMOUS_ACTOR,
      action: 'telegram.board',
      target: { type: 'board_card' },
      projectId: reached.projectId,
      after: { action, number, reason: reached.text },
      result: 'denied',
      meta: { via: 'telegram' },
    });
    return this.text(screen, reached.text);
  }

  private async record(
    scope: Scope,
    action: WriteAction,
    number: number,
    result: 'ok' | 'error',
    extra: object,
  ): Promise<void> {
    await this.audit.record({
      ...scope.actor.ctx,
      action: 'telegram.board',
      target: { type: 'board_card' },
      projectId: scope.projectId,
      after: { action, number, ...extra },
      result,
      meta: { via: 'telegram' },
    });
  }
}

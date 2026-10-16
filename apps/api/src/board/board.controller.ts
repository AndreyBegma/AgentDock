import {
  type AcceptBoardCardResponse,
  BOARD_ERROR,
  type BoardCardDetail,
  type BoardSettingsView,
  type BoardStackDetail,
  type BoardView,
  type BulkBoardCardsResponse,
  type CardDependenciesView,
  type CardPullRequestView,
  type CollectBoardCardResponse,
  type DismissAllResult,
} from '@agentdock/shared';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuditCtx } from '../audit';
import type { AuditContext } from '../audit/audit.types';
import { type AuthUser, CurrentUser } from '../auth';
import {
  ProjectAccess,
  ProjectAccessGuard,
  ProjectRole,
  type ResolvedProjectAccess,
} from '../projects';
import { BoardService } from './board.service';
import { BoardBulk } from './board-bulk';
import { BoardDependencies } from './board-dependencies.service';
import { boardError, cardNotFound } from './board-error';
import { BoardInboxService } from './board-inbox.service';
import { BoardRoundsService } from './board-rounds.service';
import { BoardStacks } from './board-stacks';
import type { BoardActor } from './board-work';
import {
  AcceptBoardCardDto,
  AcceptSuggestionDto,
  AddCardDependencyDto,
  AddStackCardDto,
  BoardQueryDto,
  BulkBoardCardsDto,
  CardFeedbackDto,
  CreateBoardCardDto,
  MoveBoardCardDto,
  RunBoardCardDto,
  UpdateBoardCardDto,
  UpdateBoardSettingsDto,
  UpdateBoardStackDto,
} from './dto';

/** A card's per-project number from the path; anything else is no card. */
export const cardNumber = (value: string): number => {
  if (!/^[1-9]\d{0,8}$/.test(value)) throw cardNotFound();
  return Number(value);
};

/** #480: a stack's per-project number from the path; anything else is no stack. */
export const stackNumber = (value: string): number => {
  if (!/^[1-9]\d{0,8}$/.test(value)) {
    throw boardError(404, BOARD_ERROR.notFound, 'Stack not found');
  }
  return Number(value);
};

const actorOf = (
  access: ResolvedProjectAccess,
  user: AuthUser,
  ctx: AuditContext,
): BoardActor => ({ userId: user.id, role: access.role, ctx });

/**
 * The project Board (issue #242 "API", D11): viewers read; operators create,
 * edit, move, run, give feedback, stop, accept and delete, and see and work
 * the Inbox (#244 D8, D9); a project admin edits the settings. A project the
 * caller cannot see is 404 on every route.
 */
@Controller('projects/:projectId')
@UseGuards(ProjectAccessGuard)
export class BoardController {
  constructor(
    private readonly board: BoardService,
    private readonly rounds: BoardRoundsService,
    private readonly inbox: BoardInboxService,
    private readonly deps: BoardDependencies,
    private readonly bulk: BoardBulk,
    private readonly stacks: BoardStacks,
  ) {}

  // ─── Stacks (#480, ADR-0043) ───────────────────────────────────────────────

  @Get('board/stacks/:number')
  stack(
    @ProjectAccess() access: ResolvedProjectAccess,
    @Param('number') number: string,
  ): Promise<BoardStackDetail> {
    return this.stacks.detail(access.projectId, stackNumber(number));
  }

  @Patch('board/stacks/:number')
  @ProjectRole('operator')
  updateStack(
    @ProjectAccess() access: ResolvedProjectAccess,
    @CurrentUser() user: AuthUser,
    @AuditCtx() ctx: AuditContext,
    @Param('number') number: string,
    @Body() dto: UpdateBoardStackDto,
  ): Promise<BoardStackDetail> {
    return this.stacks.update(
      access.projectId,
      stackNumber(number),
      dto,
      actorOf(access, user, ctx),
    );
  }

  @Post('board/stacks/:number/cards')
  @ProjectRole('operator')
  addStackCard(
    @ProjectAccess() access: ResolvedProjectAccess,
    @CurrentUser() user: AuthUser,
    @AuditCtx() ctx: AuditContext,
    @Param('number') number: string,
    @Body() dto: AddStackCardDto,
  ): Promise<BoardStackDetail> {
    return this.stacks.addCard(
      access.projectId,
      stackNumber(number),
      dto,
      actorOf(access, user, ctx),
    );
  }

  @Delete('board/stacks/:number/cards/:card')
  @ProjectRole('operator')
  removeStackCard(
    @ProjectAccess() access: ResolvedProjectAccess,
    @CurrentUser() user: AuthUser,
    @AuditCtx() ctx: AuditContext,
    @Param('number') number: string,
    @Param('card') card: string,
  ): Promise<BoardStackDetail> {
    return this.stacks.removeCard(
      access.projectId,
      stackNumber(number),
      cardNumber(card),
      actorOf(access, user, ctx),
    );
  }

  @Get('board')
  view(
    @ProjectAccess() access: ResolvedProjectAccess,
    @Query() query: BoardQueryDto,
  ): Promise<BoardView> {
    return this.board.board(
      access.projectId,
      query.completedBefore ? new Date(query.completedBefore) : undefined,
      access.role,
    );
  }

  @Post('board/cards')
  @ProjectRole('operator')
  create(
    @ProjectAccess() access: ResolvedProjectAccess,
    @CurrentUser() user: AuthUser,
    @AuditCtx() ctx: AuditContext,
    @Body() dto: CreateBoardCardDto,
  ): Promise<BoardCardDetail> {
    return this.board.create(access.projectId, dto, actorOf(access, user, ctx));
  }

  /**
   * #452: one action for several cards — each skipped or done on its own, so
   * the answer is always 200 with an outcome per card.
   */
  @Post('board/cards/bulk')
  @HttpCode(200)
  @ProjectRole('operator')
  bulkAction(
    @ProjectAccess() access: ResolvedProjectAccess,
    @CurrentUser() user: AuthUser,
    @AuditCtx() ctx: AuditContext,
    @Body() dto: BulkBoardCardsDto,
  ): Promise<BulkBoardCardsResponse> {
    return this.bulk.run(access.projectId, dto, actorOf(access, user, ctx));
  }

  @Get('board/cards/:number')
  detail(
    @ProjectAccess() access: ResolvedProjectAccess,
    @Param('number') number: string,
  ): Promise<BoardCardDetail> {
    return this.board.detail(access.projectId, cardNumber(number), access.role);
  }

  @Patch('board/cards/:number')
  @ProjectRole('operator')
  update(
    @ProjectAccess() access: ResolvedProjectAccess,
    @CurrentUser() user: AuthUser,
    @AuditCtx() ctx: AuditContext,
    @Param('number') number: string,
    @Body() dto: UpdateBoardCardDto,
  ): Promise<BoardCardDetail> {
    return this.board.update(
      access.projectId,
      cardNumber(number),
      dto,
      actorOf(access, user, ctx),
    );
  }

  @Delete('board/cards/:number')
  @HttpCode(204)
  @ProjectRole('operator')
  async delete(
    @ProjectAccess() access: ResolvedProjectAccess,
    @CurrentUser() user: AuthUser,
    @AuditCtx() ctx: AuditContext,
    @Param('number') number: string,
  ): Promise<void> {
    await this.board.delete(
      access.projectId,
      cardNumber(number),
      actorOf(access, user, ctx),
    );
  }

  @Get('board/cards/:number/dependencies')
  dependencies(
    @ProjectAccess() access: ResolvedProjectAccess,
    @Param('number') number: string,
  ): Promise<CardDependenciesView> {
    return this.deps.list(access.projectId, cardNumber(number), access.role);
  }

  @Post('board/cards/:number/dependencies')
  @HttpCode(200)
  @ProjectRole('operator')
  addDependency(
    @ProjectAccess() access: ResolvedProjectAccess,
    @CurrentUser() user: AuthUser,
    @AuditCtx() ctx: AuditContext,
    @Param('number') number: string,
    @Body() dto: AddCardDependencyDto,
  ): Promise<CardDependenciesView> {
    return this.deps.add(
      access.projectId,
      cardNumber(number),
      dto.dependsOn,
      actorOf(access, user, ctx),
    );
  }

  @Delete('board/cards/:number/dependencies/:dependsOn')
  @ProjectRole('operator')
  removeDependency(
    @ProjectAccess() access: ResolvedProjectAccess,
    @CurrentUser() user: AuthUser,
    @AuditCtx() ctx: AuditContext,
    @Param('number') number: string,
    @Param('dependsOn') dependsOn: string,
  ): Promise<CardDependenciesView> {
    return this.deps.remove(
      access.projectId,
      cardNumber(number),
      cardNumber(dependsOn),
      actorOf(access, user, ctx),
    );
  }

  @Post('board/cards/:number/move')
  @HttpCode(200)
  @ProjectRole('operator')
  move(
    @ProjectAccess() access: ResolvedProjectAccess,
    @CurrentUser() user: AuthUser,
    @AuditCtx() ctx: AuditContext,
    @Param('number') number: string,
    @Body() dto: MoveBoardCardDto,
  ): Promise<BoardCardDetail> {
    return this.board.move(
      access.projectId,
      cardNumber(number),
      dto,
      actorOf(access, user, ctx),
    );
  }

  @Post('board/cards/:number/run')
  @HttpCode(200)
  @ProjectRole('operator')
  run(
    @ProjectAccess() access: ResolvedProjectAccess,
    @CurrentUser() user: AuthUser,
    @AuditCtx() ctx: AuditContext,
    @Param('number') number: string,
    @Body() dto: RunBoardCardDto,
  ): Promise<BoardCardDetail> {
    return this.rounds.run(
      access.projectId,
      cardNumber(number),
      dto,
      actorOf(access, user, ctx),
    );
  }

  @Post('board/cards/:number/feedback')
  @HttpCode(200)
  @ProjectRole('operator')
  feedback(
    @ProjectAccess() access: ResolvedProjectAccess,
    @CurrentUser() user: AuthUser,
    @AuditCtx() ctx: AuditContext,
    @Param('number') number: string,
    @Body() dto: CardFeedbackDto,
  ): Promise<BoardCardDetail> {
    return this.rounds.feedback(
      access.projectId,
      cardNumber(number),
      dto,
      actorOf(access, user, ctx),
    );
  }

  @Post('board/cards/:number/finish')
  @HttpCode(200)
  @ProjectRole('operator')
  finish(
    @ProjectAccess() access: ResolvedProjectAccess,
    @CurrentUser() user: AuthUser,
    @AuditCtx() ctx: AuditContext,
    @Param('number') number: string,
  ): Promise<BoardCardDetail> {
    return this.board.finish(
      access.projectId,
      cardNumber(number),
      actorOf(access, user, ctx),
    );
  }

  @Post('board/cards/:number/accept')
  @HttpCode(200)
  @ProjectRole('operator')
  accept(
    @ProjectAccess() access: ResolvedProjectAccess,
    @CurrentUser() user: AuthUser,
    @AuditCtx() ctx: AuditContext,
    @Param('number') number: string,
    @Body() dto: AcceptBoardCardDto,
  ): Promise<AcceptBoardCardResponse> {
    return this.board.accept(
      access.projectId,
      cardNumber(number),
      dto,
      actorOf(access, user, ctx),
    );
  }

  /** #329 D5: Create pull request — `card.collect` now, answered with its outcome. */
  @Post('board/cards/:number/collect')
  @HttpCode(200)
  @ProjectRole('operator')
  collect(
    @ProjectAccess() access: ResolvedProjectAccess,
    @CurrentUser() user: AuthUser,
    @AuditCtx() ctx: AuditContext,
    @Param('number') number: string,
  ): Promise<CollectBoardCardResponse> {
    return this.board.collect(
      access.projectId,
      cardNumber(number),
      actorOf(access, user, ctx),
    );
  }

  /** #273 D10: operator — the read goes to the runner's `gh`. */
  @Get('board/cards/:number/pull-request')
  @ProjectRole('operator')
  pullRequest(
    @ProjectAccess() access: ResolvedProjectAccess,
    @CurrentUser() user: AuthUser,
    @AuditCtx() ctx: AuditContext,
    @Param('number') number: string,
  ): Promise<CardPullRequestView> {
    return this.board.pullRequest(
      access.projectId,
      cardNumber(number),
      actorOf(access, user, ctx),
    );
  }

  @Post('board/cards/:number/accept-suggestion')
  @HttpCode(200)
  @ProjectRole('operator')
  acceptSuggestion(
    @ProjectAccess() access: ResolvedProjectAccess,
    @CurrentUser() user: AuthUser,
    @AuditCtx() ctx: AuditContext,
    @Param('number') number: string,
    @Body() dto: AcceptSuggestionDto,
  ): Promise<BoardCardDetail> {
    return this.inbox.accept(
      access.projectId,
      cardNumber(number),
      dto,
      actorOf(access, user, ctx),
    );
  }

  @Post('board/cards/:number/dismiss')
  @HttpCode(204)
  @ProjectRole('operator')
  async dismiss(
    @ProjectAccess() access: ResolvedProjectAccess,
    @CurrentUser() user: AuthUser,
    @AuditCtx() ctx: AuditContext,
    @Param('number') number: string,
  ): Promise<void> {
    await this.inbox.dismiss(
      access.projectId,
      cardNumber(number),
      actorOf(access, user, ctx),
    );
  }

  @Post('board/inbox/dismiss-all')
  @HttpCode(200)
  @ProjectRole('operator')
  dismissAll(
    @ProjectAccess() access: ResolvedProjectAccess,
    @CurrentUser() user: AuthUser,
    @AuditCtx() ctx: AuditContext,
  ): Promise<DismissAllResult> {
    return this.inbox.dismissAll(access.projectId, actorOf(access, user, ctx));
  }

  @Post('board/cards/:number/stop')
  @HttpCode(200)
  @ProjectRole('operator')
  stop(
    @ProjectAccess() access: ResolvedProjectAccess,
    @CurrentUser() user: AuthUser,
    @AuditCtx() ctx: AuditContext,
    @Param('number') number: string,
  ): Promise<BoardCardDetail> {
    return this.board.stop(
      access.projectId,
      cardNumber(number),
      actorOf(access, user, ctx),
    );
  }

  @Get('board-settings')
  settings(
    @ProjectAccess() access: ResolvedProjectAccess,
  ): Promise<BoardSettingsView> {
    return this.board.settings(access.projectId);
  }

  @Put('board-settings')
  @ProjectRole('admin')
  updateSettings(
    @ProjectAccess() access: ResolvedProjectAccess,
    @CurrentUser() user: AuthUser,
    @AuditCtx() ctx: AuditContext,
    @Body() dto: UpdateBoardSettingsDto,
  ): Promise<BoardSettingsView> {
    return this.board.updateSettings(
      access.projectId,
      dto,
      actorOf(access, user, ctx),
    );
  }
}

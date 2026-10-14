import type {
  BoardCardDetail,
  BoardSettingsView,
  BoardView,
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
import { cardNotFound } from './board-error';
import { BoardRoundsService } from './board-rounds.service';
import type { BoardActor } from './board-work';
import {
  BoardQueryDto,
  CardFeedbackDto,
  CreateBoardCardDto,
  MoveBoardCardDto,
  RunBoardCardDto,
  UpdateBoardCardDto,
  UpdateBoardSettingsDto,
} from './dto';

/** A card's per-project number from the path; anything else is no card. */
const cardNumber = (value: string): number => {
  if (!/^[1-9]\d{0,8}$/.test(value)) throw cardNotFound();
  return Number(value);
};

const actorOf = (
  access: ResolvedProjectAccess,
  user: AuthUser,
  ctx: AuditContext,
): BoardActor => ({ userId: user.id, role: access.role, ctx });

/**
 * The project Board (issue #242 "API", D11): viewers read; operators create,
 * edit, move, run, give feedback, stop, accept and delete; a project admin
 * edits the settings. A project the caller cannot see is 404 on every route.
 */
@Controller('projects/:projectId')
@UseGuards(ProjectAccessGuard)
export class BoardController {
  constructor(
    private readonly board: BoardService,
    private readonly rounds: BoardRoundsService,
  ) {}

  @Get('board')
  view(
    @ProjectAccess() access: ResolvedProjectAccess,
    @Query() query: BoardQueryDto,
  ): Promise<BoardView> {
    return this.board.board(
      access.projectId,
      query.completedBefore ? new Date(query.completedBefore) : undefined,
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

  @Get('board/cards/:number')
  detail(
    @ProjectAccess() access: ResolvedProjectAccess,
    @Param('number') number: string,
  ): Promise<BoardCardDetail> {
    return this.board.detail(access.projectId, cardNumber(number));
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
  ): Promise<BoardCardDetail> {
    return this.board.accept(
      access.projectId,
      cardNumber(number),
      actorOf(access, user, ctx),
    );
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

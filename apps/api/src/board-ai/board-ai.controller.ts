import type {
  BoardAskResponse,
  BoardTriageCounts,
  CardTriageView,
} from '@agentdock/shared';
import {
  applyDecorators,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import type { Request } from 'express';
import type { AuditContext } from '../audit/audit.types';
import { AuditCtx } from '../audit/audit-context';
import { type AuthUser, getAuth } from '../auth/auth-request';
import { CurrentUser } from '../auth/decorators';
import { cardNumber } from '../board/board.controller';
import {
  ProjectAccess,
  ProjectAccessGuard,
  ProjectRole,
  type ResolvedProjectAccess,
} from '../projects';
import { BoardAskService } from './board-ask.service';
import { BoardTriage } from './board-triage.service';
import { BoardAskDto, TriageHintDto } from './dto';

/** Questions one person may ask per window: each is two model calls. */
export const BOARD_ASK_LIMIT = 20;
export const BOARD_ASK_WINDOW_MS = 60_000;

/** Per signed-in user, so people behind one proxy do not share a budget. */
const AskThrottle = () =>
  applyDecorators(
    Throttle({
      default: {
        limit: BOARD_ASK_LIMIT,
        ttl: BOARD_ASK_WINDOW_MS,
        getTracker: (req) => {
          const auth = getAuth(req as Request);
          return auth ? `user:${auth.user.id}` : `ip:${(req as Request).ip}`;
        },
      },
    }),
    UseGuards(ThrottlerGuard),
  );

/** #660 Ask the Board: over every project the caller can access. */
@Controller('board')
export class BoardAskController {
  constructor(private readonly ask: BoardAskService) {}

  @Post('ask')
  @HttpCode(200)
  @AskThrottle()
  question(
    @CurrentUser() user: AuthUser,
    @Body() dto: BoardAskDto,
  ): Promise<BoardAskResponse> {
    return this.ask.ask(user, dto.question);
  }
}

/** #660 triage hints: viewers read them; operators dismiss and apply. */
@Controller('projects/:projectId')
@UseGuards(ProjectAccessGuard)
export class BoardTriageController {
  constructor(private readonly triage: BoardTriage) {}

  @Get('board/triage')
  counts(
    @ProjectAccess() access: ResolvedProjectAccess,
  ): Promise<BoardTriageCounts> {
    return this.triage.counts(access.projectId);
  }

  @Get('board/cards/:number/triage')
  view(
    @ProjectAccess() access: ResolvedProjectAccess,
    @Param('number') number: string,
  ): Promise<CardTriageView> {
    return this.triage.view(access.projectId, cardNumber(number));
  }

  @Post('board/cards/:number/triage/dismiss')
  @HttpCode(200)
  @ProjectRole('operator')
  dismiss(
    @ProjectAccess() access: ResolvedProjectAccess,
    @Param('number') number: string,
    @Body() dto: TriageHintDto,
  ): Promise<CardTriageView> {
    return this.triage.dismiss(access.projectId, cardNumber(number), dto.hint);
  }

  @Post('board/cards/:number/triage/apply')
  @HttpCode(200)
  @ProjectRole('operator')
  apply(
    @ProjectAccess() access: ResolvedProjectAccess,
    @CurrentUser() user: AuthUser,
    @AuditCtx() ctx: AuditContext,
    @Param('number') number: string,
    @Body() dto: TriageHintDto,
  ): Promise<CardTriageView> {
    return this.triage.apply(access.projectId, cardNumber(number), dto.hint, {
      userId: user.id,
      role: access.role,
      ctx,
    });
  }
}

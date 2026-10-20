import type { AiSummaryView } from '@nautelle/shared';
import {
  applyDecorators,
  Body,
  Controller,
  HttpCode,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import type { Request } from 'express';
import { type AuthUser, CurrentUser } from '../auth';
import { getAuth } from '../auth/auth-request';
import { cardNumber } from '../board/board.controller';
import {
  ProjectAccess,
  ProjectAccessGuard,
  type ResolvedProjectAccess,
} from '../projects';
import { AiSummaryDto } from './dto';
import { SummariesService } from './summaries.service';

/** Summaries one person may ask for per window: each may be a model call. */
export const SUMMARY_LIMIT = 20;
export const SUMMARY_WINDOW_MS = 60_000;

/** Per signed-in user, so people behind one proxy do not share a budget. */
const SummaryThrottle = () =>
  applyDecorators(
    Throttle({
      default: {
        limit: SUMMARY_LIMIT,
        ttl: SUMMARY_WINDOW_MS,
        getTracker: (req) => {
          const auth = getAuth(req as Request);
          return auth ? `user:${auth.user.id}` : `ip:${(req as Request).ip}`;
        },
      },
    }),
    UseGuards(ThrottlerGuard),
  );

/**
 * One-click summaries (#658): any member of the project summarizes a card
 * with its PR, or a session whose content the project stores — members read
 * content (ADR-0050). A project the caller cannot see is 404. The gateway's
 * refusals pass through as they are: `llm_cap_reached` is 429 with its
 * message, which the button shows.
 */
@Controller('projects/:projectId')
@UseGuards(ProjectAccessGuard)
export class SummariesController {
  constructor(private readonly summaries: SummariesService) {}

  @Post('board/cards/:number/summary')
  @HttpCode(200)
  @SummaryThrottle()
  card(
    @ProjectAccess() access: ResolvedProjectAccess,
    @CurrentUser() user: AuthUser,
    @Param('number') number: string,
    @Body() dto: AiSummaryDto,
  ): Promise<AiSummaryView> {
    return this.summaries.card(access.projectId, cardNumber(number), {
      userId: user.id,
      language: dto.language,
      regenerate: dto.regenerate ?? false,
    });
  }

  @Post('sessions/:sessionId/summary')
  @HttpCode(200)
  @SummaryThrottle()
  session(
    @ProjectAccess() access: ResolvedProjectAccess,
    @CurrentUser() user: AuthUser,
    @Param('sessionId') sessionId: string,
    @Body() dto: AiSummaryDto,
  ): Promise<AiSummaryView> {
    return this.summaries.session(access.projectId, sessionId, {
      userId: user.id,
      language: dto.language,
      regenerate: dto.regenerate ?? false,
    });
  }
}

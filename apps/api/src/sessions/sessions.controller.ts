import type { SessionDetail, SessionListResponse } from '@agentdock/shared';
import { Controller, Get, Param, Query } from '@nestjs/common';
import type { AuthUser } from '../auth/auth-request';
import { CurrentUser } from '../auth/decorators';
import { ListSessionsQuery } from './dto';
import { SessionsQueryService } from './sessions-query.service';

/** Spec 12 API. Signed in; what each caller sees follows D10. */
@Controller('sessions')
export class SessionsController {
  constructor(private readonly sessions: SessionsQueryService) {}

  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @Query() query: ListSessionsQuery,
  ): Promise<SessionListResponse> {
    return this.sessions.list(user, query);
  }

  @Get(':id')
  detail(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ): Promise<SessionDetail> {
    return this.sessions.detail(user, id);
  }
}

import type {
  TerminalAttachView,
  TerminalTicketResponse,
} from '@agentdock/shared';
import { Body, Controller, Get, Post, Query, Req } from '@nestjs/common';
import { type AuthenticatedRequest, Roles } from '../auth';
import { TerminalActiveQueryDto, TerminalTicketDto } from './dto';
import { TerminalService } from './terminal.service';

/**
 * Terminal attach (spec 29 "API"): admin only (D1) — an operator or viewer is
 * 403, an anonymous caller 401, a project the caller cannot see 404 (#10 D12).
 * The global guards check the session, CSRF on the POST, and the role.
 */
@Controller('terminal')
@Roles('admin')
export class TerminalController {
  constructor(private readonly terminal: TerminalService) {}

  @Post('tickets')
  issueTicket(
    @Req() request: AuthenticatedRequest,
    @Body() dto: TerminalTicketDto,
  ): Promise<TerminalTicketResponse> {
    return this.terminal.issueTicket(request.auth, dto);
  }

  @Get('active')
  active(
    @Req() request: AuthenticatedRequest,
    @Query() query: TerminalActiveQueryDto,
  ): Promise<TerminalAttachView[]> {
    return this.terminal.active(request.auth, query.projectId);
  }
}

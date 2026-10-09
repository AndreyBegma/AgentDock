import {
  AUTH_ERROR,
  type PublicUser,
  type RegisterResponse,
  type RegistrationState,
  type SessionInfo,
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
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { AuditService } from '../audit/audit.service';
import { auditContextOf, requestOrigin } from '../audit/audit-context';
import { SettingsService } from '../settings/settings.service';
import { AuthService } from './auth.service';
import { authError } from './auth-error';
import type { AuthenticatedRequest, AuthUser } from './auth-request';
import { clearSessionCookies, setSessionCookies } from './cookies';
import { CurrentUser, Public } from './decorators';
import { ChangePasswordDto, LoginDto, RegisterDto } from './dto';
import { SessionService } from './session.service';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
  ) {}

  @Public()
  @UseGuards(ThrottlerGuard)
  @Post('register')
  async register(
    @Body() dto: RegisterDto,
    @Req() request: Request,
  ): Promise<RegisterResponse> {
    await this.auth.register(dto, requestOrigin(request));
    return { status: 'pending' };
  }

  @Public()
  @UseGuards(ThrottlerGuard)
  @Post('login')
  @HttpCode(200)
  async login(
    @Body() dto: LoginDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<PublicUser> {
    const { user, session } = await this.auth.login(
      dto,
      requestOrigin(request),
    );
    setSessionCookies(response, session);
    return user;
  }

  @Public()
  @Get('registration')
  async registration(): Promise<RegistrationState> {
    return { open: await this.settings.isRegistrationOpen() };
  }

  @Post('logout')
  @HttpCode(204)
  async logout(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    await this.sessions.revokeOwn(request.auth.user.id, request.auth.sessionId);
    clearSessionCookies(response);
    await this.audit.record({
      ...auditContextOf(request),
      action: 'auth.logout',
      target: { type: 'session', id: request.auth.sessionId },
      result: 'ok',
    });
  }

  @Get('me')
  me(@CurrentUser() user: AuthUser): PublicUser {
    return user;
  }

  @Patch('me/password')
  @HttpCode(204)
  async changePassword(
    @Req() request: AuthenticatedRequest,
    @Body() dto: ChangePasswordDto,
  ): Promise<void> {
    await this.auth.changePassword(request.auth, dto, requestOrigin(request));
  }

  @Get('sessions')
  listSessions(@Req() request: AuthenticatedRequest): Promise<SessionInfo[]> {
    return this.sessions.list(request.auth.user.id, request.auth.sessionId);
  }

  @Delete('sessions/:id')
  @HttpCode(204)
  async revokeSession(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<void> {
    // Scoped to the caller: a foreign id is indistinguishable from a missing one.
    if (!(await this.sessions.revokeOwn(request.auth.user.id, id))) {
      throw authError(404, AUTH_ERROR.notFound, 'Session not found');
    }
    await this.audit.record({
      ...auditContextOf(request),
      action: 'auth.session_revoke',
      target: { type: 'session', id },
      result: 'ok',
    });
  }
}

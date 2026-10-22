import {
  AUTH_ERROR,
  type CurrentUserResponse,
  type PublicUser,
  type RecoveryCodesResponse,
  type RegisterResponse,
  type RegistrationState,
  type SessionInfo,
  type TwoFactorSetupResponse,
  type TwoFactorStatus,
} from '@nautelle/shared';
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
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { AuditService } from '../audit/audit.service';
import { auditContextOf, requestOrigin } from '../audit/audit-context';
import { SettingsService } from '../settings/settings.service';
import { AuthService } from './auth.service';
import { authError, SourceThrottledFilter } from './auth-error';
import type { AuthenticatedRequest, AuthUser } from './auth-request';
import { clearSessionCookies, setSessionCookies } from './cookies';
import { AllowedBeforeTwoFactorSetup, Public } from './decorators';
import {
  ChangePasswordDto,
  LoginDto,
  RegisterDto,
  TwoFactorConfirmDto,
  TwoFactorEnableDto,
  TwoFactorSetupDto,
} from './dto';
import { SessionService } from './session.service';
import { TwoFactorService } from './two-factor.service';

// An admin who must still set up two-factor sign-in (C-189) can do it here,
// see who they are, change their password and sign out — nothing else.
@AllowedBeforeTwoFactorSetup()
@Controller('auth')
@UseFilters(SourceThrottledFilter)
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly twoFactor: TwoFactorService,
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
  async me(@Req() request: AuthenticatedRequest): Promise<CurrentUserResponse> {
    const user: AuthUser = request.auth.user;
    return {
      ...user,
      twoFactorSetupRequired:
        !user.twoFactorEnabled && (await this.twoFactor.requiredFor(user)),
    };
  }

  // Per IP, as for login; the wrong-password counter is the login one (C-109).
  @UseGuards(ThrottlerGuard)
  @Patch('me/password')
  @HttpCode(204)
  async changePassword(
    @Req() request: AuthenticatedRequest,
    @Body() dto: ChangePasswordDto,
  ): Promise<void> {
    await this.auth.changePassword(request.auth, dto, requestOrigin(request));
  }

  @Get('me/two-factor')
  twoFactorStatus(
    @Req() request: AuthenticatedRequest,
  ): Promise<TwoFactorStatus> {
    return this.auth.twoFactorStatus(request.auth);
  }

  // The password and code checks share the login counter, so the same per-IP
  // request limit as login (C-109).
  @UseGuards(ThrottlerGuard)
  @Post('me/two-factor/setup')
  @HttpCode(200)
  beginTwoFactorSetup(
    @Req() request: AuthenticatedRequest,
    @Body() dto: TwoFactorSetupDto,
  ): Promise<TwoFactorSetupResponse> {
    return this.auth.beginTwoFactorSetup(
      request.auth,
      dto.password,
      requestOrigin(request),
    );
  }

  @UseGuards(ThrottlerGuard)
  @Post('me/two-factor/enable')
  @HttpCode(200)
  async enableTwoFactor(
    @Req() request: AuthenticatedRequest,
    @Body() dto: TwoFactorEnableDto,
  ): Promise<RecoveryCodesResponse> {
    return {
      recoveryCodes: await this.auth.enableTwoFactor(
        request.auth,
        dto.code,
        requestOrigin(request),
      ),
    };
  }

  @UseGuards(ThrottlerGuard)
  @Post('me/two-factor/disable')
  @HttpCode(204)
  async disableTwoFactor(
    @Req() request: AuthenticatedRequest,
    @Body() dto: TwoFactorConfirmDto,
  ): Promise<void> {
    await this.auth.disableTwoFactor(request.auth, dto, requestOrigin(request));
  }

  @UseGuards(ThrottlerGuard)
  @Post('me/two-factor/recovery-codes')
  @HttpCode(200)
  async regenerateRecoveryCodes(
    @Req() request: AuthenticatedRequest,
    @Body() dto: TwoFactorConfirmDto,
  ): Promise<RecoveryCodesResponse> {
    return {
      recoveryCodes: await this.auth.regenerateRecoveryCodes(
        request.auth,
        dto,
        requestOrigin(request),
      ),
    };
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

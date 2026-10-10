import type {
  GitHubAppView,
  GitHubHookAnswer,
  GitHubManifestResponse,
  GitHubProjectAppStatus,
  GitHubResyncResult,
} from '@agentdock/shared';
import { GITHUB_HEADERS } from '@agentdock/shared';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Post,
  Put,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import type { AuditContext } from '../audit/audit.types';
import { AuditCtx } from '../audit/audit-context';
import type { AuthUser } from '../auth/auth-request';
import { CurrentUser, Public, Roles } from '../auth/decorators';
import {
  ProjectAccess,
  ProjectAccessGuard,
  type ResolvedProjectAccess,
} from '../projects';
import type { RawBodyRequest } from '../webhooks/common';
import {
  GitHubAppCredentialsDto,
  GitHubCallbackQuery,
  GitHubManifestDto,
} from './dto';
import { GitHubHealthService } from './github-health.service';
import { GitHubHookService } from './github-hook.service';
import { GitHubRegistrationService } from './github-registration.service';

/**
 * `POST /hooks/github` (spec 27 D5–D9): public, signed. Answers 200 before
 * any poll is sent (D6); the polls and resyncs run after the response.
 */
@Controller('hooks/github')
export class GitHubHookController {
  constructor(private readonly hooks: GitHubHookService) {}

  @Public()
  @Post()
  @HttpCode(200)
  async receive(
    @Req() req: Request & RawBodyRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<GitHubHookAnswer> {
    const { answer, work } = await this.hooks.receive({
      rawBody: req.rawBody,
      signature: req.get(GITHUB_HEADERS.signature),
      deliveryId: req.get(GITHUB_HEADERS.delivery),
      event: req.get(GITHUB_HEADERS.event),
    });
    res.on('finish', () => this.hooks.after(work));
    return answer;
  }
}

/** `/admin/github-app*` (D15): admins only. */
@Roles('admin')
@Controller('admin/github-app')
export class GitHubAppAdminController {
  constructor(private readonly registration: GitHubRegistrationService) {}

  @Get()
  view(): Promise<GitHubAppView> {
    return this.registration.view();
  }

  @Post('manifest')
  @HttpCode(200)
  manifest(
    @Body() dto: GitHubManifestDto,
    @CurrentUser() admin: AuthUser,
  ): Promise<GitHubManifestResponse> {
    return this.registration.manifest(dto.owner, admin.id);
  }

  /** D1: the browser lands here from the web callback page; answers a redirect. */
  @Get('callback')
  async callback(
    @Query() query: GitHubCallbackQuery,
    @CurrentUser() admin: AuthUser,
    @AuditCtx() ctx: AuditContext,
    @Res() res: Response,
  ): Promise<void> {
    const location = await this.registration.callback(
      query.code,
      query.state,
      admin.id,
      ctx,
    );
    res.redirect(302, location);
  }

  @Put()
  putCredentials(
    @Body() dto: GitHubAppCredentialsDto,
    @CurrentUser() admin: AuthUser,
    @AuditCtx() ctx: AuditContext,
  ): Promise<GitHubAppView> {
    return this.registration.putCredentials(dto, admin.id, ctx);
  }

  @Post('resync')
  @HttpCode(200)
  resync(@AuditCtx() ctx: AuditContext): Promise<GitHubResyncResult> {
    return this.registration.resync(ctx);
  }

  @Delete()
  @HttpCode(204)
  remove(@AuditCtx() ctx: AuditContext): Promise<void> {
    return this.registration.remove(ctx);
  }
}

/** `GET /projects/:projectId/github-app` (D15): any member; a non-member gets 404. */
@Controller('projects/:projectId/github-app')
@UseGuards(ProjectAccessGuard)
export class ProjectGitHubAppController {
  constructor(private readonly health: GitHubHealthService) {}

  @Get()
  status(
    @ProjectAccess() access: ResolvedProjectAccess,
  ): Promise<GitHubProjectAppStatus> {
    return this.health.statusFor(access.projectId);
  }
}

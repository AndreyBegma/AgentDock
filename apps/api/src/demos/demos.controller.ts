import {
  type CardDemoView,
  DEMO_UPLOAD_HEADERS,
  type DemoRunnerView,
  type DemoSecretView,
  type DemoSettingsView,
  demoIdSchema,
  type RunnerDemoEnvView,
} from '@nautelle/shared';
import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import type { AuditContext } from '../audit/audit.types';
import { AuditCtx } from '../audit/audit-context';
import { type AuthUser, BearerBody, CurrentUser, Public } from '../auth';
import { cardNumber } from '../board/board.controller';
import {
  ProjectAccess,
  ProjectAccessGuard,
  ProjectRole,
  type ResolvedProjectAccess,
} from '../projects';
import { CardDemosService } from './card-demos.service';
import { DemoSettingsService, demoSecretName } from './demo-settings.service';
import { demoNotFound } from './demos-error';
import { PutDemoSecretDto, UpdateDemoSettingsDto } from './dto';

/** A demo id from the path; anything else is no demo. */
const demoId = (value: string): string => {
  if (!demoIdSchema.safeParse(value).success) throw demoNotFound();
  return value;
};

/** A non-negative integer header, or `null` when it is absent or not one. */
const intHeader = (value: string | undefined): number | null => {
  if (value === undefined || !/^\d{1,10}$/.test(value)) return null;
  return Number(value);
};

/**
 * A project's Demo videos settings and Demo env secrets (C-368, ADR-0090).
 * Any member reads them; writes need the project admin role. A secret's
 * value is write-only: every route answers with names.
 */
@Controller('projects/:projectId/demos')
@UseGuards(ProjectAccessGuard)
export class DemoSettingsController {
  constructor(private readonly settings: DemoSettingsService) {}

  @Get('settings')
  view(
    @ProjectAccess() access: ResolvedProjectAccess,
  ): Promise<DemoSettingsView> {
    return this.settings.view(access.projectId);
  }

  @Patch('settings')
  @ProjectRole('admin')
  update(
    @ProjectAccess() access: ResolvedProjectAccess,
    @CurrentUser() user: AuthUser,
    @AuditCtx() ctx: AuditContext,
    @Body() dto: UpdateDemoSettingsDto,
  ): Promise<DemoSettingsView> {
    return this.settings.update(access.projectId, dto, user.id, ctx);
  }

  @Get('runner')
  runner(
    @ProjectAccess() access: ResolvedProjectAccess,
  ): Promise<DemoRunnerView> {
    return this.settings.runner(access.projectId);
  }

  @Get('secrets')
  secrets(
    @ProjectAccess() access: ResolvedProjectAccess,
  ): Promise<DemoSecretView[]> {
    return this.settings.secrets(access.projectId);
  }

  @Put('secrets/:name')
  @ProjectRole('admin')
  putSecret(
    @ProjectAccess() access: ResolvedProjectAccess,
    @CurrentUser() user: AuthUser,
    @AuditCtx() ctx: AuditContext,
    @Param('name') name: string,
    @Body() dto: PutDemoSecretDto,
  ): Promise<DemoSecretView> {
    return this.settings.putSecret(
      access.projectId,
      demoSecretName(name),
      dto.value,
      user.id,
      ctx,
    );
  }

  @Delete('secrets/:name')
  @HttpCode(204)
  @ProjectRole('admin')
  deleteSecret(
    @ProjectAccess() access: ResolvedProjectAccess,
    @AuditCtx() ctx: AuditContext,
    @Param('name') name: string,
  ): Promise<void> {
    return this.settings.deleteSecret(
      access.projectId,
      demoSecretName(name),
      ctx,
    );
  }
}

/**
 * A card's demo recordings (C-368, ADR-0090): every member lists them; an
 * operator or above asks for one more with "Record again".
 */
@Controller('projects/:projectId/board/cards/:number/demos')
@UseGuards(ProjectAccessGuard)
export class CardDemosController {
  constructor(private readonly demos: CardDemosService) {}

  @Get()
  list(
    @ProjectAccess() access: ResolvedProjectAccess,
    @Param('number') number: string,
  ): Promise<CardDemoView[]> {
    return this.demos.list(access.projectId, cardNumber(number), access.role);
  }

  @Post()
  @ProjectRole('operator')
  request(
    @ProjectAccess() access: ResolvedProjectAccess,
    @CurrentUser() user: AuthUser,
    @AuditCtx() ctx: AuditContext,
    @Param('number') number: string,
  ): Promise<CardDemoView> {
    return this.demos.request(
      access.projectId,
      cardNumber(number),
      access.role,
      user.id,
      ctx,
    );
  }
}

/**
 * The runner's side of a demo (ADR-0090), with its runner token, never a
 * session: it fetches the project's Demo env secrets for the `demoflow`
 * process and uploads the video it recorded. The token, the project's runner
 * and the demo's status are checked before a byte of the body is read.
 */
@Controller('runner/cards/:number/demos/:demoId')
export class RunnerDemosController {
  constructor(private readonly demos: CardDemosService) {}

  @Get('env')
  @Public()
  async env(
    @Headers('authorization') authorization: string | undefined,
    @Param('number') number: string,
    @Param('demoId') id: string,
  ): Promise<RunnerDemoEnvView> {
    const demo = await this.demos.forRunner(
      authorization,
      cardNumber(number),
      demoId(id),
    );
    return { env: await this.demos.env(demo) };
  }

  @Post('video')
  @Public()
  @BearerBody()
  @HttpCode(201)
  async video(
    @Headers('authorization') authorization: string | undefined,
    @Param('number') number: string,
    @Param('demoId') id: string,
    @Req() req: Request,
  ): Promise<CardDemoView> {
    const demo = await this.demos.forRunner(
      authorization,
      cardNumber(number),
      demoId(id),
    );
    return this.demos.upload(demo, {
      body: req,
      contentLength: intHeader(req.get('content-length')),
      sha256: req.get(DEMO_UPLOAD_HEADERS.sha256) ?? '',
      durationMs: intHeader(req.get(DEMO_UPLOAD_HEADERS.durationMs)),
    });
  }
}

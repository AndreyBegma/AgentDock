import {
  PLANNER_ERROR,
  type PlanDetail,
  type PlanListView,
  type PlannerSettingsView,
  type PlanTurnInput,
  planTurnInputSchema,
} from '@agentdock/shared';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { AuditCtx } from '../audit';
import type { AuditContext } from '../audit/audit.types';
import { type AuthUser, CurrentUser } from '../auth';
import {
  ProjectAccess,
  ProjectAccessGuard,
  ProjectRole,
  type ResolvedProjectAccess,
} from '../projects';
import {
  CreatePlanDto,
  PlannerSettingsDto,
  PlanTaskReviewDto,
  PlanTurnDto,
  PlanVisibilityDto,
} from './dto';
import { callerOf, type PlanActor, PlanService } from './plan.service';
import { PlanSendService } from './plan-send.service';
import { PlanStore } from './plan-store';
import { PlanTurnService } from './plan-turn.service';
import { plannerError } from './planner-error';
import { PlannerInstructionsService } from './planner-instructions.service';

/** A turn's input: a message, answers, or both — never neither (D7). */
const turnInputOf = (dto: PlanTurnDto): PlanTurnInput => {
  const parsed = planTurnInputSchema.safeParse({
    ...(dto.message !== undefined ? { message: dto.message } : {}),
    ...(dto.answers !== undefined
      ? {
          answers: dto.answers.map((a) => ({
            questionId: a.questionId,
            ...(a.optionId !== undefined ? { optionId: a.optionId } : {}),
            ...(a.text !== undefined ? { text: a.text } : {}),
          })),
        }
      : {}),
  });
  if (!parsed.success) {
    throw plannerError(
      400,
      PLANNER_ERROR.invalidArgs,
      z.prettifyError(parsed.error),
    );
  }
  if (!parsed.data.message && !parsed.data.answers?.length) {
    throw plannerError(
      400,
      PLANNER_ERROR.invalidArgs,
      'A turn needs a message or answers',
    );
  }
  return parsed.data;
};

const actorOf = (
  access: ResolvedProjectAccess,
  user: AuthUser,
  ctx: AuditContext,
): PlanActor => ({ userId: user.id, role: access.role, ctx });

/**
 * A project's plans (spec 172 "API", D12, D13). `ProjectAccessGuard` hides a
 * project the caller cannot see (404) and refuses writes below operator
 * (403); every route then reads the plan through the readability rule, so a
 * plan the caller may not read is 404 as well. Writes answer the plan's
 * detail as the caller now sees it.
 */
@Controller('projects/:projectId')
@UseGuards(ProjectAccessGuard)
export class PlansController {
  constructor(
    private readonly plans: PlanService,
    private readonly turns: PlanTurnService,
    private readonly sender: PlanSendService,
    private readonly store: PlanStore,
    private readonly instructions: PlannerInstructionsService,
  ) {}

  @Post('plans')
  @ProjectRole('operator')
  create(
    @ProjectAccess() access: ResolvedProjectAccess,
    @CurrentUser() user: AuthUser,
    @AuditCtx() ctx: AuditContext,
    @Body() dto: CreatePlanDto,
  ): Promise<PlanDetail> {
    return this.plans.create(access.projectId, actorOf(access, user, ctx), dto);
  }

  @Get('plans')
  list(
    @ProjectAccess() access: ResolvedProjectAccess,
    @CurrentUser() user: AuthUser,
  ): Promise<PlanListView> {
    return this.plans.list(access.projectId, user.id);
  }

  @Get('plans/:planId')
  detail(
    @ProjectAccess() access: ResolvedProjectAccess,
    @CurrentUser() user: AuthUser,
    @Param('planId') planId: string,
  ): Promise<PlanDetail> {
    return this.plans.detail(access.projectId, user.id, planId);
  }

  @Post('plans/:planId/turns')
  @ProjectRole('operator')
  async planTurn(
    @ProjectAccess() access: ResolvedProjectAccess,
    @CurrentUser() user: AuthUser,
    @AuditCtx() ctx: AuditContext,
    @Param('planId') planId: string,
    @Body() dto: PlanTurnDto,
  ): Promise<PlanDetail> {
    const plan = await this.store.readable(user.id, access.projectId, planId);
    const actor = actorOf(access, user, ctx);
    await this.turns.planTurn(plan, turnInputOf(dto), callerOf(actor));
    return this.plans.detail(access.projectId, user.id, planId);
  }

  @Post('plans/:planId/tasks/:key/turns')
  @ProjectRole('operator')
  async taskTurn(
    @ProjectAccess() access: ResolvedProjectAccess,
    @CurrentUser() user: AuthUser,
    @AuditCtx() ctx: AuditContext,
    @Param('planId') planId: string,
    @Param('key') key: string,
    @Body() dto: PlanTurnDto,
  ): Promise<PlanDetail> {
    const plan = await this.store.readable(user.id, access.projectId, planId);
    const actor = actorOf(access, user, ctx);
    await this.turns.taskTurn(plan, key, turnInputOf(dto), callerOf(actor));
    return this.plans.detail(access.projectId, user.id, planId);
  }

  @Post('plans/:planId/tasks/:key/review')
  @HttpCode(200)
  @ProjectRole('operator')
  async review(
    @ProjectAccess() access: ResolvedProjectAccess,
    @CurrentUser() user: AuthUser,
    @AuditCtx() ctx: AuditContext,
    @Param('planId') planId: string,
    @Param('key') key: string,
    @Body() dto: PlanTaskReviewDto,
  ): Promise<PlanDetail> {
    const plan = await this.store.readable(user.id, access.projectId, planId);
    await this.plans.review(
      plan,
      key,
      dto.decision,
      dto.comment,
      actorOf(access, user, ctx),
    );
    return this.plans.detail(access.projectId, user.id, planId);
  }

  @Post('plans/:planId/revise')
  @ProjectRole('operator')
  async revise(
    @ProjectAccess() access: ResolvedProjectAccess,
    @CurrentUser() user: AuthUser,
    @AuditCtx() ctx: AuditContext,
    @Param('planId') planId: string,
  ): Promise<PlanDetail> {
    const plan = await this.store.readable(user.id, access.projectId, planId);
    await this.turns.revise(plan, callerOf(actorOf(access, user, ctx)));
    return this.plans.detail(access.projectId, user.id, planId);
  }

  @Post('plans/:planId/visibility')
  @HttpCode(200)
  @ProjectRole('operator')
  async visibility(
    @ProjectAccess() access: ResolvedProjectAccess,
    @CurrentUser() user: AuthUser,
    @AuditCtx() ctx: AuditContext,
    @Param('planId') planId: string,
    @Body() dto: PlanVisibilityDto,
  ): Promise<PlanDetail> {
    const plan = await this.store.readable(user.id, access.projectId, planId);
    await this.plans.setVisibility(
      plan,
      dto.visibility,
      actorOf(access, user, ctx),
    );
    return this.plans.detail(access.projectId, user.id, planId);
  }

  @Post('plans/:planId/send')
  @HttpCode(200)
  @ProjectRole('operator')
  async send(
    @ProjectAccess() access: ResolvedProjectAccess,
    @CurrentUser() user: AuthUser,
    @AuditCtx() ctx: AuditContext,
    @Param('planId') planId: string,
  ): Promise<PlanDetail> {
    const plan = await this.store.readable(user.id, access.projectId, planId);
    await this.sender.send(plan, actorOf(access, user, ctx));
    return this.plans.detail(access.projectId, user.id, planId);
  }

  @Post('plans/:planId/archive')
  @HttpCode(200)
  @ProjectRole('operator')
  async archive(
    @ProjectAccess() access: ResolvedProjectAccess,
    @CurrentUser() user: AuthUser,
    @AuditCtx() ctx: AuditContext,
    @Param('planId') planId: string,
  ): Promise<PlanDetail> {
    const plan = await this.store.readable(user.id, access.projectId, planId);
    await this.plans.archive(plan, actorOf(access, user, ctx));
    return this.plans.detail(access.projectId, user.id, planId);
  }

  @Post('plans/:planId/turns/:turnId/cancel')
  @HttpCode(200)
  @ProjectRole('operator')
  async cancel(
    @ProjectAccess() access: ResolvedProjectAccess,
    @CurrentUser() user: AuthUser,
    @AuditCtx() ctx: AuditContext,
    @Param('planId') planId: string,
    @Param('turnId') turnId: string,
  ): Promise<PlanDetail> {
    const plan = await this.store.readable(user.id, access.projectId, planId);
    await this.turns.cancel(plan, turnId, callerOf(actorOf(access, user, ctx)));
    return this.plans.detail(access.projectId, user.id, planId);
  }

  @Post('plans/:planId/turns/:turnId/retry')
  @ProjectRole('operator')
  async retry(
    @ProjectAccess() access: ResolvedProjectAccess,
    @CurrentUser() user: AuthUser,
    @AuditCtx() ctx: AuditContext,
    @Param('planId') planId: string,
    @Param('turnId') turnId: string,
  ): Promise<PlanDetail> {
    const plan = await this.store.readable(user.id, access.projectId, planId);
    await this.turns.retry(plan, turnId, callerOf(actorOf(access, user, ctx)));
    return this.plans.detail(access.projectId, user.id, planId);
  }

  @Get('planner/settings')
  settings(
    @ProjectAccess() access: ResolvedProjectAccess,
  ): Promise<PlannerSettingsView> {
    return this.instructions.settings(access.projectId);
  }

  @Put('planner/settings')
  @ProjectRole('admin')
  updateSettings(
    @ProjectAccess() access: ResolvedProjectAccess,
    @CurrentUser() user: AuthUser,
    @AuditCtx() ctx: AuditContext,
    @Body() dto: PlannerSettingsDto,
  ): Promise<PlannerSettingsView> {
    return this.instructions.updateSettings(
      ctx,
      user.id,
      access.projectId,
      dto,
    );
  }
}

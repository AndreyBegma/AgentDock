import {
  type AcceptCandidatesResponse,
  type ConfirmSplitResponse,
  type CreatePlanCardsResponse,
  PLANNER_ERROR,
  type PlanCandidateView,
  type PlanDetail,
  type PlanListView,
  type PlannerSettingsView,
  type PlanTaskVersionsView,
  type PlanTurnInput,
  planTurnInputSchema,
} from '@nautelle/shared';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
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
  AcceptCandidatesDto,
  ConfirmSplitDto,
  CreatePlanDto,
  PlannerSettingsDto,
  PlanTaskReviewDto,
  PlanTurnDto,
  PlanVisibilityDto,
  UpdatePlanCandidateDto,
} from './dto';
import { callerOf, type PlanActor, PlanService } from './plan.service';
import { PlanCandidatesService } from './plan-candidates.service';
import { PlanCardsService } from './plan-cards.service';
import { PlanSendService } from './plan-send.service';
import { PlanStore } from './plan-store';
import { PlanTurnService } from './plan-turn.service';
import { plannerError } from './planner-error';
import { PlannerInstructionsService } from './planner-instructions.service';

/**
 * A turn's input: a message, answers, or both — never neither (D7); or, on
 * a card intake, Enough — generate (#337 D3) or Keep one card (#409) on its
 * own.
 */
const turnInputOf = (dto: PlanTurnDto): PlanTurnInput => {
  const parsed = planTurnInputSchema.safeParse({
    ...(dto.message !== undefined ? { message: dto.message } : {}),
    ...(dto.answers !== undefined
      ? {
          answers: dto.answers.map((a) => ({
            questionId: a.questionId,
            ...(a.optionId !== undefined ? { optionId: a.optionId } : {}),
            ...(a.optionIds !== undefined ? { optionIds: a.optionIds } : {}),
            ...(a.text !== undefined ? { text: a.text } : {}),
          })),
        }
      : {}),
    ...(dto.generate === true ? { generate: true } : {}),
    ...(dto.keepOne === true ? { keepOne: true } : {}),
    ...(dto.attachmentIds?.length ? { attachmentIds: dto.attachmentIds } : {}),
  });
  if (!parsed.success) {
    throw plannerError(
      400,
      PLANNER_ERROR.invalidArgs,
      z.prettifyError(parsed.error),
    );
  }
  if (
    !parsed.data.message &&
    !parsed.data.answers?.length &&
    !parsed.data.generate &&
    !parsed.data.keepOne
  ) {
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
    private readonly planCards: PlanCardsService,
    private readonly candidates: PlanCandidatesService,
  ) {}

  /**
   * A plan the caller may read and that still takes work: not one from
   * before the Board planner (#337 D11), which stays read-only.
   */
  private async writable(userId: string, projectId: string, planId: string) {
    const plan = await this.store.readable(userId, projectId, planId);
    this.store.assertCurrent(plan);
    return plan;
  }

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

  @Get('plans/:planId/tasks/:key/versions')
  taskVersions(
    @ProjectAccess() access: ResolvedProjectAccess,
    @CurrentUser() user: AuthUser,
    @Param('planId') planId: string,
    @Param('key') key: string,
  ): Promise<PlanTaskVersionsView> {
    return this.plans.taskVersions(access.projectId, user.id, planId, key);
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
    const plan = await this.writable(user.id, access.projectId, planId);
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
    const plan = await this.writable(user.id, access.projectId, planId);
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
    const plan = await this.writable(user.id, access.projectId, planId);
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
    const plan = await this.writable(user.id, access.projectId, planId);
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
    const plan = await this.writable(user.id, access.projectId, planId);
    await this.sender.send(plan, actorOf(access, user, ctx));
    return this.plans.detail(access.projectId, user.id, planId);
  }

  /** #337 D7: Create cards — the alternative to Send to fleet. */
  @Post('plans/:planId/cards')
  @ProjectRole('operator')
  async cards(
    @ProjectAccess() access: ResolvedProjectAccess,
    @CurrentUser() user: AuthUser,
    @AuditCtx() ctx: AuditContext,
    @Param('planId') planId: string,
  ): Promise<CreatePlanCardsResponse> {
    const plan = await this.writable(user.id, access.projectId, planId);
    return this.planCards.create(plan, actorOf(access, user, ctx));
  }

  /**
   * #409: Confirm a split — the cards the person kept, all at once. #592:
   * they become candidates in Drafts.
   */
  @Post('plans/:planId/split')
  @ProjectRole('operator')
  async split(
    @ProjectAccess() access: ResolvedProjectAccess,
    @CurrentUser() user: AuthUser,
    @Param('planId') planId: string,
    @Body() body: ConfirmSplitDto,
  ): Promise<ConfirmSplitResponse> {
    const plan = await this.writable(user.id, access.projectId, planId);
    return this.planCards.confirmSplit(plan, body);
  }

  /** #592 (ADR-0058): the person edits a candidate by hand. */
  @Patch('plans/:planId/candidates/:candidateId')
  @ProjectRole('operator')
  async updateCandidate(
    @ProjectAccess() access: ResolvedProjectAccess,
    @CurrentUser() user: AuthUser,
    @AuditCtx() ctx: AuditContext,
    @Param('planId') planId: string,
    @Param('candidateId') candidateId: string,
    @Body() body: UpdatePlanCandidateDto,
  ): Promise<PlanCandidateView> {
    const plan = await this.writable(user.id, access.projectId, planId);
    return this.candidates.update(
      plan,
      candidateId,
      body,
      actorOf(access, user, ctx),
    );
  }

  /** #592: Reject — no card is made. */
  @Post('plans/:planId/candidates/:candidateId/reject')
  @HttpCode(200)
  @ProjectRole('operator')
  async rejectCandidate(
    @ProjectAccess() access: ResolvedProjectAccess,
    @CurrentUser() user: AuthUser,
    @AuditCtx() ctx: AuditContext,
    @Param('planId') planId: string,
    @Param('candidateId') candidateId: string,
  ): Promise<PlanCandidateView> {
    const plan = await this.writable(user.id, access.projectId, planId);
    return this.candidates.reject(
      plan,
      candidateId,
      actorOf(access, user, ctx),
    );
  }

  /** #592: Accept — candidates of one intake or several, as cards or one stack. */
  @Post('candidates/accept')
  @HttpCode(200)
  @ProjectRole('operator')
  acceptCandidates(
    @ProjectAccess() access: ResolvedProjectAccess,
    @CurrentUser() user: AuthUser,
    @AuditCtx() ctx: AuditContext,
    @Body() body: AcceptCandidatesDto,
  ): Promise<AcceptCandidatesResponse> {
    return this.candidates.accept(
      access.projectId,
      user.id,
      body,
      actorOf(access, user, ctx),
    );
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
    const plan = await this.writable(user.id, access.projectId, planId);
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

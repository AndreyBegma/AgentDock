import type { BudgetRecomputeResult, BudgetView } from '@agentdock/shared';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import type { AuditContext } from '../audit/audit.types';
import { AuditCtx } from '../audit/audit-context';
import type { AuthUser } from '../auth/auth-request';
import { CurrentUser, Roles } from '../auth/decorators';
import {
  ProjectAccess,
  ProjectAccessGuard,
  ProjectRole,
  type ResolvedProjectAccess,
} from '../projects';
import { BudgetsService } from './budgets.service';
import {
  AdminBudgetCreateDto,
  BudgetCreateDto,
  BudgetListQueryDto,
  BudgetOverrideDto,
  BudgetRecomputeDto,
  BudgetUpdateDto,
} from './dto';

/**
 * A project's budgets (spec 28 D10). Any member reads them; only an admin
 * changes them. A project the caller cannot see is 404 (#10 D12), an operator
 * changing one 403.
 */
@Controller('projects/:projectId/budgets')
@UseGuards(ProjectAccessGuard)
export class ProjectBudgetsController {
  constructor(private readonly budgets: BudgetsService) {}

  @Get()
  list(@ProjectAccess() access: ResolvedProjectAccess): Promise<BudgetView[]> {
    return this.budgets.listForProject(access.projectId);
  }

  @Post()
  @ProjectRole('admin')
  create(
    @ProjectAccess() access: ResolvedProjectAccess,
    @CurrentUser() user: AuthUser,
    @AuditCtx() ctx: AuditContext,
    @Body() dto: BudgetCreateDto,
  ): Promise<BudgetView> {
    return this.budgets.createForProject(access.projectId, dto, {
      userId: user.id,
      ctx,
    });
  }

  @Patch(':budgetId')
  @ProjectRole('admin')
  update(
    @ProjectAccess() access: ResolvedProjectAccess,
    @Param('budgetId') budgetId: string,
    @CurrentUser() user: AuthUser,
    @AuditCtx() ctx: AuditContext,
    @Body() dto: BudgetUpdateDto,
  ): Promise<BudgetView> {
    return this.budgets.update(
      budgetId,
      dto,
      { userId: user.id, ctx },
      access.projectId,
    );
  }

  @Delete(':budgetId')
  @ProjectRole('admin')
  @HttpCode(204)
  remove(
    @ProjectAccess() access: ResolvedProjectAccess,
    @Param('budgetId') budgetId: string,
    @CurrentUser() user: AuthUser,
    @AuditCtx() ctx: AuditContext,
  ): Promise<void> {
    return this.budgets.remove(
      budgetId,
      { userId: user.id, ctx },
      access.projectId,
    );
  }
}

/** The caller's own user budgets (D10) — never anyone else's. */
@Controller('me/budgets')
export class MyBudgetsController {
  constructor(private readonly budgets: BudgetsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser): Promise<BudgetView[]> {
    return this.budgets.listForUser(user.id);
  }
}

/** Every budget, either scope, plus override and recompute (D8, D4). Admins only. */
@Roles('admin')
@Controller('admin/budgets')
export class AdminBudgetsController {
  constructor(private readonly budgets: BudgetsService) {}

  @Get()
  list(@Query() query: BudgetListQueryDto): Promise<BudgetView[]> {
    return this.budgets.listAll(query);
  }

  @Post()
  create(
    @CurrentUser() user: AuthUser,
    @AuditCtx() ctx: AuditContext,
    @Body() dto: AdminBudgetCreateDto,
  ): Promise<BudgetView> {
    return this.budgets.createAdmin(dto, { userId: user.id, ctx });
  }

  @Post('recompute')
  @HttpCode(200)
  recompute(
    @CurrentUser() user: AuthUser,
    @AuditCtx() ctx: AuditContext,
    @Body() dto: BudgetRecomputeDto,
  ): Promise<BudgetRecomputeResult> {
    return this.budgets.recompute(dto.budgetId, { userId: user.id, ctx });
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @AuditCtx() ctx: AuditContext,
    @Body() dto: BudgetUpdateDto,
  ): Promise<BudgetView> {
    return this.budgets.update(id, dto, { userId: user.id, ctx });
  }

  @Delete(':id')
  @HttpCode(204)
  remove(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @AuditCtx() ctx: AuditContext,
  ): Promise<void> {
    return this.budgets.remove(id, { userId: user.id, ctx });
  }

  @Post(':id/override')
  override(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @AuditCtx() ctx: AuditContext,
    @Body() dto: BudgetOverrideDto,
  ): Promise<BudgetView> {
    return this.budgets.override(id, dto, { userId: user.id, ctx });
  }

  @Delete(':id/override')
  revoke(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @AuditCtx() ctx: AuditContext,
  ): Promise<BudgetView> {
    return this.budgets.revoke(id, { userId: user.id, ctx });
  }
}

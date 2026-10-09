import {
  BUDGET_ERROR,
  type BudgetListQuery,
  type BudgetOverrideView,
  type BudgetRecomputeResult,
  type BudgetScope,
  type BudgetView,
  isValidTimeZone,
  normalizeThresholds,
  periodAt,
} from '@agentdock/shared';
import { Inject, Injectable } from '@nestjs/common';
import { type Budget, Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import type { AuditContext } from '../audit/audit.types';
import { PrismaService } from '../database/prisma.service';
import { budgetError, budgetNotFound } from './budget-error';
import {
  activeOverride,
  BudgetEvaluator,
  toPeriodView,
} from './budget-evaluator';
import {
  BUDGET_OPTIONS,
  BudgetClock,
  type BudgetOptions,
} from './budget-options';
import type {
  AdminBudgetCreateDto,
  BudgetCreateDto,
  BudgetOverrideDto,
  BudgetUpdateDto,
} from './dto';

/** Who changes a budget, for the audit log and `createdById` / `byId`. */
export interface BudgetActor {
  userId: string;
  ctx: AuditContext;
}

type BudgetWithNames = Budget & {
  project: { displayName: string } | null;
  user: { email: string } | null;
};

const withNames = {
  project: { select: { displayName: true } },
  user: { select: { email: true } },
} as const;

/** What the audit log shows of a budget (D8: before / after). */
const snapshot = (b: Budget) => ({
  scope: b.scope,
  projectId: b.projectId,
  userId: b.userId,
  period: b.period,
  timezone: b.timezone,
  limitUsd: b.limitUsd.toFixed(4),
  thresholds: b.thresholds,
  action: b.action,
  enabled: b.enabled,
});

type OverrideRow = Prisma.BudgetOverrideGetPayload<{
  include: { by: { select: { id: true; email: true } } };
}>;

const toOverrideView = (o: OverrideRow): BudgetOverrideView => ({
  id: o.id,
  periodStart: o.periodStart.toISOString(),
  until: o.until.toISOString(),
  reason: o.reason,
  by: o.by,
  createdAt: o.createdAt.toISOString(),
});

const invalid = (message: string) =>
  budgetError(400, BUDGET_ERROR.invalidArgs, message);

const isUniqueViolation = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError &&
  error.code === 'P2002';

const duplicate = () =>
  budgetError(
    409,
    BUDGET_ERROR.duplicate,
    'An enabled budget with this scope and period already exists',
  );

/**
 * Budgets (spec 28): D1 validation, views with the current period, the D8
 * override and the D4 recompute. Every change is audited with before/after.
 * Who may call what is the controllers' business (D10).
 */
@Injectable()
export class BudgetsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly evaluator: BudgetEvaluator,
    private readonly clock: BudgetClock,
    @Inject(BUDGET_OPTIONS) private readonly options: BudgetOptions,
  ) {}

  // ─── Reads ────────────────────────────────────────────────────────────────

  async listForProject(projectId: string): Promise<BudgetView[]> {
    return this.views(
      await this.prisma.budget.findMany({
        where: { scope: 'project', projectId },
        include: withNames,
        orderBy: { createdAt: 'asc' },
      }),
    );
  }

  /** `GET /me/budgets`: the caller's own user budgets, nobody else's. */
  async listForUser(userId: string): Promise<BudgetView[]> {
    return this.views(
      await this.prisma.budget.findMany({
        where: { scope: 'user', userId },
        include: withNames,
        orderBy: { createdAt: 'asc' },
      }),
    );
  }

  async listAll(query: BudgetListQuery): Promise<BudgetView[]> {
    const views = await this.views(
      await this.prisma.budget.findMany({
        where: query.scope ? { scope: query.scope } : {},
        include: withNames,
        orderBy: { createdAt: 'asc' },
      }),
    );
    return query.state
      ? views.filter((v) => v.current?.state === query.state)
      : views;
  }

  async view(budgetId: string): Promise<BudgetView> {
    const budget = await this.prisma.budget.findUnique({
      where: { id: budgetId },
      include: withNames,
    });
    if (!budget) throw budgetNotFound();
    const [view] = await this.views([budget]);
    return view;
  }

  /** Budgets with their current period; a missing period is opened. */
  private async views(budgets: BudgetWithNames[]): Promise<BudgetView[]> {
    const now = this.clock.now();
    const views: BudgetView[] = [];
    for (const b of budgets) {
      let current: BudgetView['current'] = null;
      let override: BudgetOverrideView | null = null;
      if (b.enabled) {
        const { start } = periodAt(b.period, b.timezone, now);
        let row = await this.prisma.budgetPeriodRow.findUnique({
          where: { budgetId_start: { budgetId: b.id, start } },
        });
        if (!row) row = (await this.evaluator.evaluate(b.id))?.row ?? null;
        const active = await activeOverride(this.prisma, b.id, start, now);
        override = active ? toOverrideView(active) : null;
        current = row ? toPeriodView(b, row, active !== null) : null;
      }
      views.push({
        id: b.id,
        scope: b.scope,
        projectId: b.projectId,
        userId: b.userId,
        scopeName: b.project?.displayName ?? b.user?.email ?? null,
        period: b.period,
        timezone: b.timezone,
        limitUsd: b.limitUsd.toFixed(4),
        thresholds: [...b.thresholds],
        action: b.action,
        enabled: b.enabled,
        createdAt: b.createdAt.toISOString(),
        updatedAt: b.updatedAt.toISOString(),
        current,
        override,
      });
    }
    return views;
  }

  // ─── Changes ──────────────────────────────────────────────────────────────

  createForProject(
    projectId: string,
    dto: BudgetCreateDto,
    actor: BudgetActor,
  ): Promise<BudgetView> {
    return this.create('project', projectId, null, dto, actor);
  }

  async createAdmin(
    dto: AdminBudgetCreateDto,
    actor: BudgetActor,
  ): Promise<BudgetView> {
    if (dto.scope === 'project') {
      if (!dto.projectId || dto.userId) {
        throw invalid('A project budget names a projectId and no userId');
      }
      const project = await this.prisma.project.findUnique({
        where: { id: dto.projectId },
        select: { id: true },
      });
      if (!project) throw invalid('projectId names no project');
      return this.create('project', dto.projectId, null, dto, actor);
    }
    if (!dto.userId || dto.projectId) {
      throw invalid('A user budget names a userId and no projectId');
    }
    const user = await this.prisma.user.findUnique({
      where: { id: dto.userId },
      select: { id: true },
    });
    if (!user) throw invalid('userId names no user');
    return this.create('user', null, dto.userId, dto, actor);
  }

  private async create(
    scope: BudgetScope,
    projectId: string | null,
    userId: string | null,
    dto: BudgetCreateDto,
    actor: BudgetActor,
  ): Promise<BudgetView> {
    const fields = this.fields(dto, true);
    let budget: Budget;
    try {
      budget = await this.prisma.budget.create({
        data: {
          scope,
          projectId,
          userId,
          period: dto.period,
          action: dto.action,
          enabled: dto.enabled ?? true,
          timezone: fields.timezone ?? this.options.defaultTimezone,
          limitUsd: fields.limitUsd as Prisma.Decimal,
          thresholds: fields.thresholds as number[],
          createdById: actor.userId,
        },
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw duplicate();
      throw error;
    }
    await this.record(actor, 'budget.create', budget, {
      after: snapshot(budget),
    });
    if (budget.enabled) await this.evaluator.evaluate(budget.id);
    return this.view(budget.id);
  }

  async update(
    budgetId: string,
    dto: BudgetUpdateDto,
    actor: BudgetActor,
    projectId?: string,
  ): Promise<BudgetView> {
    const before = await this.find(budgetId, projectId);
    const fields = this.fields(dto, false);
    let after: Budget;
    try {
      after = await this.prisma.budget.update({
        where: { id: budgetId },
        data: {
          ...(dto.period ? { period: dto.period } : {}),
          ...(dto.action ? { action: dto.action } : {}),
          ...(dto.enabled !== undefined ? { enabled: dto.enabled } : {}),
          ...(fields.timezone ? { timezone: fields.timezone } : {}),
          ...(fields.limitUsd ? { limitUsd: fields.limitUsd } : {}),
          ...(fields.thresholds ? { thresholds: fields.thresholds } : {}),
        },
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw duplicate();
      throw error;
    }
    await this.record(actor, 'budget.update', after, {
      before: snapshot(before),
      after: snapshot(after),
    });
    if (after.enabled) await this.evaluator.evaluate(after.id);
    return this.view(budgetId);
  }

  async remove(
    budgetId: string,
    actor: BudgetActor,
    projectId?: string,
  ): Promise<void> {
    const before = await this.find(budgetId, projectId);
    await this.prisma.budget.delete({ where: { id: budgetId } });
    await this.record(actor, 'budget.delete', before, {
      before: snapshot(before),
    });
  }

  /**
   * D8: lifts a `stop` budget for its current period until `until`, at most
   * the period's end. A newer override replaces an active one.
   */
  async override(
    budgetId: string,
    dto: BudgetOverrideDto,
    actor: BudgetActor,
  ): Promise<BudgetView> {
    const budget = await this.find(budgetId);
    if (budget.action !== 'stop') {
      throw budgetError(
        409,
        BUDGET_ERROR.notStop,
        'Only a stop budget can be overridden',
      );
    }
    const now = this.clock.now();
    const until = new Date(dto.until);
    const period = periodAt(budget.period, budget.timezone, now);
    if (until <= now || until > period.end) {
      throw invalid(
        `until must be after now and at most the period end (${period.end.toISOString()})`,
      );
    }
    const { previous, created } = await this.prisma.$transaction(async (tx) => {
      const previous = await activeOverride(tx, budgetId, period.start, now);
      if (previous) {
        await tx.budgetOverride.update({
          where: { id: previous.id },
          data: { revokedAt: now, revokedById: actor.userId },
        });
      }
      const created = await tx.budgetOverride.create({
        data: {
          budgetId,
          periodStart: period.start,
          until,
          reason: dto.reason,
          byId: actor.userId,
        },
        include: { by: { select: { id: true, email: true } } },
      });
      return { previous, created };
    });
    await this.record(actor, 'budget.override', budget, {
      before: { override: previous ? toOverrideView(previous) : null },
      after: { override: toOverrideView(created) },
      meta: { reason: dto.reason },
    });
    await this.evaluator.evaluate(budgetId);
    return this.view(budgetId);
  }

  /** D8: ends the active override now; the gate refuses again at once. */
  async revoke(budgetId: string, actor: BudgetActor): Promise<BudgetView> {
    const budget = await this.find(budgetId);
    const now = this.clock.now();
    const { start } = periodAt(budget.period, budget.timezone, now);
    const active = await activeOverride(this.prisma, budgetId, start, now);
    if (!active) {
      throw budgetError(
        409,
        BUDGET_ERROR.noOverride,
        'The budget has no active override',
      );
    }
    const revoked = await this.prisma.budgetOverride.update({
      where: { id: active.id },
      data: { revokedAt: now, revokedById: actor.userId },
    });
    await this.record(actor, 'budget.override_revoke', budget, {
      before: { override: toOverrideView(active) },
      after: {
        override: { ...toOverrideView(active), revokedAt: revoked.revokedAt },
      },
      meta: { reason: active.reason },
    });
    await this.evaluator.evaluate(budgetId);
    return this.view(budgetId);
  }

  /**
   * D4: rebuilds every stored period of one budget, or of all, from
   * `llm_requests` — after #13 re-priced a range, say. Past periods get their
   * spend only; thresholds fire only in the current one.
   */
  async recompute(
    budgetId: string | undefined,
    actor: BudgetActor,
  ): Promise<BudgetRecomputeResult> {
    if (budgetId) await this.find(budgetId);
    const budgets = await this.prisma.budget.findMany({
      where: budgetId ? { id: budgetId } : {},
      select: {
        id: true,
        enabled: true,
        periods: { select: { start: true }, orderBy: { start: 'asc' } },
      },
    });
    let periods = 0;
    for (const b of budgets) {
      for (const p of b.periods) {
        if (await this.evaluator.evaluate(b.id, p.start)) periods += 1;
      }
      if (b.enabled && b.periods.length === 0) {
        if (await this.evaluator.evaluate(b.id)) periods += 1;
      }
    }
    const result = { budgets: budgets.length, periods };
    await this.audit.record({
      ...actor.ctx,
      action: 'budget.recompute',
      target: { type: 'budget', id: budgetId ?? null },
      after: result,
      result: 'ok',
    });
    return result;
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  /** A budget, scoped to `projectId` when the route is a project's. */
  private async find(budgetId: string, projectId?: string): Promise<Budget> {
    const budget = await this.prisma.budget.findUnique({
      where: { id: budgetId },
    });
    if (!budget) throw budgetNotFound();
    if (projectId !== undefined && budget.projectId !== projectId) {
      throw budgetNotFound();
    }
    return budget;
  }

  /**
   * D1 rules the DTO cannot express. On an update absent input stays absent;
   * on a create the thresholds default.
   */
  private fields(dto: BudgetUpdateDto, creating: boolean) {
    if (dto.timezone !== undefined && !isValidTimeZone(dto.timezone)) {
      throw invalid(`timezone ${dto.timezone} is not an IANA zone`);
    }
    let limitUsd: Prisma.Decimal | undefined;
    if (dto.limitUsd !== undefined) {
      limitUsd = new Prisma.Decimal(dto.limitUsd);
      if (limitUsd.lte(0)) throw invalid('limitUsd must be greater than 0');
    }
    let thresholds: number[] | undefined;
    if (creating || dto.thresholds !== undefined) {
      const normalized = normalizeThresholds(dto.thresholds);
      if (!normalized) {
        throw invalid('thresholds must be whole percents 1–100, at most 10');
      }
      thresholds = normalized;
    }
    return { timezone: dto.timezone, limitUsd, thresholds };
  }

  private record(
    actor: BudgetActor,
    action:
      | 'budget.create'
      | 'budget.update'
      | 'budget.delete'
      | 'budget.override'
      | 'budget.override_revoke',
    budget: Budget,
    change: { before?: object; after?: object; meta?: object },
  ): Promise<void> {
    return this.audit.record({
      ...actor.ctx,
      action,
      target: { type: 'budget', id: budget.id },
      projectId: budget.projectId,
      ...change,
      result: 'ok',
    });
  }
}

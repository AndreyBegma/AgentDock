import {
  BUDGET_UPDATED_LIVE_EVENT,
  type BudgetPeriodView,
  type BudgetUpdatedEvent,
  budgetState,
  periodAt,
} from '@agentdock/shared';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { type Budget, type BudgetPeriodRow, Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { LiveService } from '../live/live.service';
import {
  NotificationWriter,
  type Recipient,
  type WrittenNotification,
} from '../notifications/notification-writer';
import { NotificationsService } from '../notifications/notifications.service';
import {
  BUDGET_OPTIONS,
  BudgetClock,
  type BudgetOptions,
} from './budget-options';
import { type SpendScope, spendOf } from './budget-spend';

type Tx = Prisma.TransactionClient;
type Db = Tx | PrismaService;

/** A budget's period after an evaluation. */
export interface Evaluated {
  budget: Budget;
  row: BudgetPeriodRow;
  /** Spend reached the limit (100 %). */
  exceeded: boolean;
  overrideActive: boolean;
}

const BUDGET_LOCK_PREFIX = 'budget:';

export const scopeOf = (budget: Budget): SpendScope =>
  budget.scope === 'project'
    ? { scope: 'project', projectId: budget.projectId as string }
    : { scope: 'user', userId: budget.userId as string };

/** Thresholds the spend has reached: `spent * 100 >= limit * t`. */
export const crossedThresholds = (
  thresholds: readonly number[],
  spent: Prisma.Decimal,
  limit: Prisma.Decimal,
): number[] => thresholds.filter((t) => spent.mul(100).gte(limit.mul(t)));

/** The override lifting `budgetId` for the period starting `periodStart` at `now` (D8). */
export const activeOverride = (
  db: Db,
  budgetId: string,
  periodStart: Date,
  now: Date,
) =>
  db.budgetOverride.findFirst({
    where: {
      budgetId,
      periodStart,
      revokedAt: null,
      until: { gt: now },
    },
    orderBy: { createdAt: 'desc' },
    include: { by: { select: { id: true, email: true } } },
  });

export const toPeriodView = (
  budget: Budget,
  row: BudgetPeriodRow,
  overrideActive: boolean,
): BudgetPeriodView => {
  const spent = row.spentUsd;
  const percent = budget.limitUsd.isZero()
    ? 0
    : spent.mul(100).div(budget.limitUsd).toDecimalPlaces(1).toNumber();
  return {
    start: row.start.toISOString(),
    end: row.end.toISOString(),
    spentUsd: spent.toFixed(6),
    percent,
    unpricedRequests: row.unpricedRequests,
    firedThresholds: [...row.firedThresholds],
    exceededAt: row.exceededAt?.toISOString() ?? null,
    state: budgetState(
      crossedThresholds(budget.thresholds, spent, budget.limitUsd),
      overrideActive,
    ),
  };
};

const usd = (value: Prisma.Decimal) => `$${value.toFixed(2)}`;

/**
 * Brings one period of one budget up to date (D5, D6, D9): its spend rebuilt
 * from `llm_requests`, and — when it is the current period of an enabled
 * budget — every threshold the spend has reached and that has not fired yet
 * this period, fired once. Evaluations of one budget serialize on an advisory
 * lock, so a threshold cannot fire twice from two racing callers. A new
 * period starts with nothing fired: rows are per `(budget, start)`.
 */
@Injectable()
export class BudgetEvaluator {
  private readonly logger = new Logger(BudgetEvaluator.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly writer: NotificationWriter,
    private readonly notifications: NotificationsService,
    private readonly live: LiveService,
    private readonly clock: BudgetClock,
    @Inject(BUDGET_OPTIONS) private readonly options: BudgetOptions,
  ) {}

  /**
   * Evaluates the period of `budgetId` containing `at` (default: now). A past
   * period is only refreshed when it was stored; null when there is nothing
   * to evaluate (no such budget, or a past period never opened).
   */
  async evaluate(budgetId: string, at?: Date): Promise<Evaluated | null> {
    const now = this.clock.now();
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${BUDGET_LOCK_PREFIX + budgetId}))`;
      const budget = await tx.budget.findUnique({ where: { id: budgetId } });
      if (!budget) return null;
      const range = periodAt(budget.period, budget.timezone, at ?? now);
      const current = range.start <= now && now < range.end;
      const existing = await tx.budgetPeriodRow.findUnique({
        where: { budgetId_start: { budgetId, start: range.start } },
      });
      if (!current && !existing) return null;

      const spend = await spendOf(
        tx,
        scopeOf(budget),
        range.start,
        range.end,
        this.options.orchestratorMatchMs,
      );
      const crossed = crossedThresholds(
        budget.thresholds,
        spend.spentUsd,
        budget.limitUsd,
      );
      const fired = existing?.firedThresholds ?? [];
      const newly =
        current && budget.enabled
          ? crossed.filter((t) => !fired.includes(t))
          : [];
      const data = {
        end: range.end,
        spentUsd: spend.spentUsd,
        unpricedRequests: spend.unpricedRequests,
        firedThresholds: [...new Set([...fired, ...newly])].sort(
          (a, b) => a - b,
        ),
        exceededAt: existing?.exceededAt ?? (newly.includes(100) ? now : null),
        reconciledAt: now,
      };
      const row = await tx.budgetPeriodRow.upsert({
        where: { budgetId_start: { budgetId, start: range.start } },
        create: { budgetId, start: range.start, ...data },
        update: data,
      });
      const override = current
        ? await activeOverride(tx, budgetId, range.start, now)
        : null;
      const written =
        newly.length > 0 ? await this.notify(tx, budget, row, newly, now) : [];
      return {
        evaluated: {
          budget,
          row,
          exceeded: crossed.includes(100),
          overrideActive: override !== null,
        },
        written,
        current,
      };
    });
    if (!result) return null;
    await this.notifications.publish(result.written);
    if (result.current) this.publish(result.evaluated);
    return result.evaluated;
  }

  /** D6: one notification per newly reached threshold; 100 % is `budget.exceeded`. */
  private async notify(
    tx: Tx,
    budget: Budget,
    row: BudgetPeriodRow,
    thresholds: number[],
    now: Date,
  ): Promise<WrittenNotification[]> {
    const recipients = await this.recipients(tx, budget);
    if (recipients.length === 0) return [];
    const name = await this.scopeName(tx, budget);
    const link =
      budget.scope === 'project'
        ? `/projects/${budget.projectId}/settings/budget`
        : '/usage';
    const written: WrittenNotification[] = [];
    for (const t of thresholds) {
      const exceeded = t === 100;
      const what =
        budget.action === 'stop' && exceeded
          ? ' New orchestrator starts and skill runs are refused until it resets; running workers continue.'
          : '';
      written.push(
        ...(await this.writer.write(
          tx,
          {
            kind: exceeded ? 'budget.exceeded' : 'budget.threshold',
            projectId: budget.projectId,
            runnerId: null,
            slot: null,
            issue: null,
            title: exceeded
              ? `Budget exceeded — ${name}`
              : `Budget ${t} % reached — ${name}`,
            body: `${usd(row.spentUsd)} of ${usd(budget.limitUsd)} this ${budget.period}; resets ${row.end.toISOString()}.${what}`,
            link,
            eventId: null,
            at: now,
            fold: false,
          },
          recipients,
        )),
      );
    }
    return written;
  }

  /**
   * D6: a project budget goes to the project's operators and admins (no
   * viewers); a user budget to that user and the admins.
   */
  private async recipients(tx: Tx, budget: Budget): Promise<Recipient[]> {
    if (budget.scope === 'project' && budget.projectId) {
      const all = await this.writer.projectRecipients(tx, budget.projectId);
      return all.filter((r) => r.role !== 'viewer');
    }
    const admins = await this.writer.adminRecipients(tx);
    const user = budget.userId
      ? await tx.user.findFirst({
          where: { id: budget.userId, status: 'active' },
          select: { id: true, role: true },
        })
      : null;
    if (!user || admins.some((a) => a.userId === user.id)) return admins;
    return [...admins, { userId: user.id, role: user.role }];
  }

  private async scopeName(tx: Tx, budget: Budget): Promise<string> {
    if (budget.scope === 'project' && budget.projectId) {
      const project = await tx.project.findUnique({
        where: { id: budget.projectId },
        select: { displayName: true },
      });
      return project?.displayName ?? 'project';
    }
    const user = budget.userId
      ? await tx.user.findUnique({
          where: { id: budget.userId },
          select: { email: true },
        })
      : null;
    return user?.email ?? 'user';
  }

  /** D12: indicators move without a reload. */
  private publish(e: Evaluated): void {
    const event: BudgetUpdatedEvent = {
      budgetId: e.budget.id,
      scope: e.budget.scope,
      projectId: e.budget.projectId,
      userId: e.budget.userId,
      current: toPeriodView(e.budget, e.row, e.overrideActive),
    };
    const topic =
      e.budget.scope === 'project'
        ? `project:${e.budget.projectId}`
        : `user:${e.budget.userId}`;
    try {
      this.live.publish(topic, BUDGET_UPDATED_LIVE_EVENT, event);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.warn(`${BUDGET_UPDATED_LIVE_EVENT} not published: ${reason}`);
    }
  }
}

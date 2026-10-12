import { periodAt } from '@agentdock/shared';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { BudgetEvaluator } from './budget-evaluator';
import {
  BUDGET_OPTIONS,
  BudgetClock,
  type BudgetOptions,
} from './budget-options';

const HOUR_MS = 3_600_000;

/**
 * When budgets are evaluated (D5): the fast path after a rollup rebuild —
 * `onUsage`, debounced to one pass per `debounceMs` — and the sweep every
 * `sweepMs`, which reconciles every open period, closes the periods whose end
 * has passed with a last reconciliation, and opens the next ones (D9). The
 * sweep is the safety net; a gate check evaluates on its own.
 */
@Injectable()
export class BudgetSweep implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(BudgetSweep.name);
  private readonly dirty = new Set<number>();
  private debounce: NodeJS.Timeout | undefined;
  private sweepTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly prisma: PrismaService,
    private readonly evaluator: BudgetEvaluator,
    private readonly clock: BudgetClock,
    @Inject(BUDGET_OPTIONS) private readonly options: BudgetOptions,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.options.autoStart) return;
    this.sweepTimer = setInterval(() => {
      void this.sweep().catch((error: unknown) => this.failed('sweep', error));
    }, this.options.sweepMs);
    this.sweepTimer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.sweepTimer);
    clearTimeout(this.debounce);
  }

  /**
   * Called by #13's rollup service with the UTC hours (epoch ms) it rebuilt,
   * inside its transaction: only remembers them. The evaluation runs after
   * the debounce, when the rebuild has committed.
   */
  onUsage(hours: Iterable<number>): void {
    for (const h of hours) this.dirty.add(h);
    if (!this.options.autoStart || this.debounce) return;
    this.debounce = setTimeout(() => {
      this.debounce = undefined;
      void this.flush().catch((error: unknown) =>
        this.failed('evaluation', error),
      );
    }, this.options.debounceMs);
    this.debounce.unref();
  }

  /** Evaluates every period of every enabled budget the dirty hours touch. */
  async flush(): Promise<number> {
    const hours = [...this.dirty];
    this.dirty.clear();
    if (hours.length === 0) return 0;
    const budgets = await this.prisma.budget.findMany({
      where: { enabled: true },
      select: { id: true, period: true, timezone: true },
    });
    let evaluated = 0;
    for (const b of budgets) {
      // An hour can straddle two periods in a zone off the whole hour.
      const starts = new Map<number, Date>();
      for (const h of hours) {
        for (const at of [new Date(h), new Date(h + HOUR_MS - 1)]) {
          const { start } = periodAt(b.period, b.timezone, at);
          starts.set(start.getTime(), at);
        }
      }
      for (const at of starts.values()) {
        if (await this.evaluator.evaluate(b.id, at)) evaluated += 1;
      }
    }
    return evaluated;
  }

  /**
   * One sweep: a final reconciliation of each stored period that has ended
   * since it was last reconciled, then the current period of every enabled
   * budget — opened if it does not exist yet.
   */
  async sweep(): Promise<number> {
    const now = this.clock.now();
    const ended = await this.prisma.budgetPeriodRow.findMany({
      where: {
        end: { lte: now },
        reconciledAt: { lt: this.prisma.budgetPeriodRow.fields.end },
        budget: { enabled: true },
      },
      select: { budgetId: true, start: true },
    });
    let evaluated = 0;
    for (const p of ended) {
      if (await this.evaluator.evaluate(p.budgetId, p.start)) evaluated += 1;
    }
    const budgets = await this.prisma.budget.findMany({
      where: { enabled: true },
      select: { id: true },
    });
    for (const { id } of budgets) {
      if (await this.evaluator.evaluate(id)) evaluated += 1;
    }
    return evaluated;
  }

  private failed(what: string, error: unknown): void {
    const reason = error instanceof Error ? error.message : String(error);
    this.logger.error(`budget ${what} failed: ${reason}`);
  }
}

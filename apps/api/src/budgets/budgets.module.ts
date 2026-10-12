import { Global, Module } from '@nestjs/common';
import { LiveModule } from '../live/live.module';
import { NotificationsModule } from '../notifications';
import { ProjectsModule } from '../projects';
import { BudgetEvaluator } from './budget-evaluator';
import { BudgetGate } from './budget-gate';
import {
  BUDGET_OPTIONS,
  BudgetClock,
  budgetOptionsFromEnv,
} from './budget-options';
import { BudgetSweep } from './budget-sweep';
import {
  AdminBudgetsController,
  MyBudgetsController,
  ProjectBudgetsController,
} from './budgets.controller';
import { BudgetsService } from './budgets.service';

/**
 * Budgets (docs/specs/28). Global so the gated entry points — #17's control
 * service, #24's skill runs, #13's rollup service — inject `BudgetGate` and
 * `BudgetSweep` without importing this module; each takes it `@Optional()`,
 * so a build without it means "allowed" (D11).
 */
@Global()
@Module({
  imports: [LiveModule, NotificationsModule, ProjectsModule],
  controllers: [
    ProjectBudgetsController,
    MyBudgetsController,
    AdminBudgetsController,
  ],
  providers: [
    { provide: BUDGET_OPTIONS, useFactory: () => budgetOptionsFromEnv() },
    BudgetClock,
    BudgetEvaluator,
    BudgetGate,
    BudgetSweep,
    BudgetsService,
  ],
  exports: [BudgetGate, BudgetSweep, BudgetClock],
})
export class BudgetsModule {}

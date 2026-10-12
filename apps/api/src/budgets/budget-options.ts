import { isValidTimeZone } from '@agentdock/shared';
import { Injectable } from '@nestjs/common';

export const BUDGET_OPTIONS = Symbol('BUDGET_OPTIONS');

export interface BudgetOptions {
  /** Starts the debounce timer and the sweep; off under `APP_ENV=test`. */
  autoStart: boolean;
  /** D5: at most one fast-path evaluation per this many ms. */
  debounceMs: number;
  /** D5: the reconciliation sweep's interval. */
  sweepMs: number;
  /** D1: `APP_TIMEZONE`, else `UTC`. */
  defaultTimezone: string;
  /** D3: how long after an `orchestrator.start` its session may begin. */
  orchestratorMatchMs: number;
}

export const budgetOptionsFromEnv = (
  env: NodeJS.ProcessEnv = process.env,
): BudgetOptions => {
  const zone = env.APP_TIMEZONE?.trim();
  return {
    autoStart: env.APP_ENV !== 'test',
    debounceMs: 30_000,
    sweepMs: 5 * 60_000,
    defaultTimezone: zone && isValidTimeZone(zone) ? zone : 'UTC',
    orchestratorMatchMs: 120_000,
  };
};

/**
 * The time budgets see. Periods, overrides and thresholds all read it, so a
 * test moves it across a period boundary instead of waiting for one.
 */
@Injectable()
export class BudgetClock {
  private fixed: Date | null = null;

  now(): Date {
    return this.fixed ? new Date(this.fixed) : new Date();
  }

  /** Test hook: pins the clock; null returns to real time. */
  set(at: Date | null): void {
    this.fixed = at;
  }
}

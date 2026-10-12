/**
 * Budgets (docs/specs/28-budgets.md). Money is API-equivalent dollars (#13),
 * carried as decimal strings so no float ever rounds a limit or a spend.
 */

export const BUDGET_SCOPES = ['project', 'user'] as const;
export type BudgetScope = (typeof BUDGET_SCOPES)[number];

/** D1: weeks start on Monday. */
export const BUDGET_PERIODS = ['day', 'week', 'month'] as const;
export type BudgetPeriod = (typeof BUDGET_PERIODS)[number];

/** D7: `stop` refuses new spend; neither ever kills running work. */
export const BUDGET_ACTIONS = ['alert', 'stop'] as const;
export type BudgetAction = (typeof BUDGET_ACTIONS)[number];

/**
 * - `ok`: no threshold crossed this period;
 * - `warning`: a threshold below 100 % crossed;
 * - `exceeded`: 100 % crossed;
 * - `overridden`: exceeded, and an admin override lets starts through (D8).
 */
export const BUDGET_STATES = [
  'ok',
  'warning',
  'exceeded',
  'overridden',
] as const;
export type BudgetState = (typeof BUDGET_STATES)[number];

/** D1 defaults; 100 is always present. */
export const BUDGET_DEFAULT_THRESHOLDS: readonly number[] = [50, 80, 100];
export const BUDGET_MAX_THRESHOLDS = 10;
/** `limitUsd` is Decimal(14,4): at most 10 integer and 4 fraction digits. */
export const BUDGET_LIMIT_PATTERN = /^\d{1,10}(\.\d{1,4})?$/;
export const BUDGET_OVERRIDE_REASON_MAX = 500;

export interface BudgetOverrideView {
  id: string;
  /** Start of the period it lifts (D8). */
  periodStart: string;
  until: string;
  reason: string;
  /** Null when the admin was deleted. */
  by: { id: string; email: string } | null;
  createdAt: string;
}

/** The budget's current period (D9). */
export interface BudgetPeriodView {
  start: string;
  /** Exclusive; also when the budget resets. */
  end: string;
  /** Decimal string, 6 fraction digits. */
  spentUsd: string;
  /** Of `limitUsd`, rounded to 0.1; may exceed 100. */
  percent: number;
  /** D2: requests with no price, counted as zero. */
  unpricedRequests: number;
  firedThresholds: number[];
  exceededAt: string | null;
  state: BudgetState;
}

export interface BudgetView {
  id: string;
  scope: BudgetScope;
  projectId: string | null;
  userId: string | null;
  /** The scope's name for lists; null when the row is gone. */
  scopeName: string | null;
  period: BudgetPeriod;
  /** IANA zone the period is cut in. */
  timezone: string;
  /** Decimal string, 4 fraction digits. */
  limitUsd: string;
  thresholds: number[];
  action: BudgetAction;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  /** Null while the budget is disabled. */
  current: BudgetPeriodView | null;
  /** The active override of the current period, if any. */
  override: BudgetOverrideView | null;
}

/** `POST /projects/:id/budgets`. */
export interface BudgetCreateRequest {
  period: BudgetPeriod;
  /** Default: the server's `APP_TIMEZONE`, else `UTC`. */
  timezone?: string;
  limitUsd: string;
  /** Default `BUDGET_DEFAULT_THRESHOLDS`; 100 is added when missing. */
  thresholds?: number[];
  action: BudgetAction;
  /** Default true. */
  enabled?: boolean;
}

/** `POST /admin/budgets` — either scope. */
export interface AdminBudgetCreateRequest extends BudgetCreateRequest {
  scope: BudgetScope;
  /** Exactly one of the two, matching `scope`. */
  projectId?: string;
  userId?: string;
}

/** `PATCH …/budgets/:id` — the scope never changes. */
export type BudgetUpdateRequest = Partial<BudgetCreateRequest>;

/** `GET /admin/budgets`. */
export interface BudgetListQuery {
  scope?: BudgetScope;
  state?: BudgetState;
}

/** `POST /admin/budgets/:id/override` (D8). */
export interface BudgetOverrideRequest {
  /** ISO instant, in the future and at most the current period's end. */
  until: string;
  reason: string;
}

/** `POST /admin/budgets/recompute` (D4). */
export interface BudgetRecomputeRequest {
  budgetId?: string;
}

export interface BudgetRecomputeResult {
  budgets: number;
  periods: number;
}

export const BUDGET_ERROR = {
  notFound: 'not_found',
  forbidden: 'forbidden',
  invalidArgs: 'invalid_args',
  /** Another enabled budget has the same scope and period (D1). */
  duplicate: 'budget_duplicate',
  /** An override on an `alert` budget, or with no active one to revoke. */
  noOverride: 'no_override',
  notStop: 'not_stop',
  /** A gated action refused (D7, D11). */
  exceeded: 'budget_exceeded',
} as const;
export type BudgetErrorCode = (typeof BUDGET_ERROR)[keyof typeof BUDGET_ERROR];

export interface BudgetErrorBody {
  statusCode: number;
  error: BudgetErrorCode;
  message: string;
}

/**
 * What `orchestrator.start` / `next` (#17) and a skill run start (#24) answer
 * when a `stop` budget of their scope is exceeded (D7, D11).
 */
export interface BudgetExceededBody {
  statusCode: 409;
  error: typeof BUDGET_ERROR.exceeded;
  message: string;
  budgetId: string;
  scope: BudgetScope;
  /** End of the exceeded period, ISO. */
  resetsAt: string;
}

/** D12: on `project:<id>` (project budgets) or `user:<id>` (user budgets). */
export const BUDGET_UPDATED_LIVE_EVENT = 'budget.updated';

export interface BudgetUpdatedEvent {
  budgetId: string;
  scope: BudgetScope;
  projectId: string | null;
  userId: string | null;
  current: BudgetPeriodView;
}

import {
  BUDGET_ACTIONS,
  BUDGET_DEFAULT_THRESHOLDS,
  BUDGET_ERROR,
  BUDGET_LIMIT_PATTERN,
  BUDGET_OVERRIDE_REASON_MAX,
  type BudgetAction,
  type BudgetCreateRequest,
  type BudgetExceededBody,
  type BudgetOverrideRequest,
  type BudgetPeriod,
  type BudgetScope,
  type BudgetState,
  type BudgetUpdateRequest,
  type BudgetView,
  isValidTimeZone,
  normalizeThresholds,
} from '@agentdock/shared';
import { ApiError, describeError } from '../api';

type Tone = 'ok' | 'warn' | 'danger' | 'neutral';

export const STATE_LABEL: Record<BudgetState, string> = {
  ok: 'ok',
  warning: 'warning',
  exceeded: 'exceeded',
  overridden: 'overridden',
};

export const STATE_TONE: Record<BudgetState, Tone> = {
  ok: 'ok',
  warning: 'warn',
  exceeded: 'danger',
  overridden: 'warn',
};

export const PERIOD_LABEL: Record<BudgetPeriod, string> = {
  day: 'Daily',
  week: 'Weekly',
  month: 'Monthly',
};

export const ACTION_LABEL: Record<BudgetAction, string> = {
  alert: 'Alert only',
  stop: 'Stop new spend',
};

export const ACTION_HINT: Record<BudgetAction, string> = {
  alert: 'Notifies at each threshold. Nothing is refused.',
  stop: 'After 100 % new orchestrator starts and skill runs are refused until the period resets. Running workers are never stopped.',
};

export const SCOPE_LABEL: Record<BudgetScope, string> = {
  project: 'Project',
  user: 'User',
};

/** `10` → `$10.00`; spend keeps cents, a limit keeps up to four fraction digits. */
export function formatBudgetUsd(value: string, maxFraction = 2): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return `$${n.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: maxFraction,
  })}`;
}

export const formatLimit = (limitUsd: string): string =>
  formatBudgetUsd(limitUsd, 4);

export const formatPercent = (percent: number): string =>
  `${Number.isInteger(percent) ? percent : percent.toFixed(1)} %`;

/** "$3.20 of $10.00 (32 %)" — the progress label. */
export function spendLabel(budget: BudgetView): string {
  const current = budget.current;
  if (!current) return `Disabled · limit ${formatLimit(budget.limitUsd)}`;
  return `${formatBudgetUsd(current.spentUsd)} of ${formatLimit(budget.limitUsd)} (${formatPercent(current.percent)})`;
}

/** Width of the bar's fill is the progress component's; the tone follows the state. */
export const budgetTone = (state: BudgetState | undefined): Tone =>
  state ? STATE_TONE[state] : 'neutral';

export function unpricedHint(count: number): string | undefined {
  if (count <= 0) return undefined;
  return `${count} unpriced request${count === 1 ? '' : 's'}`;
}

/** A moment in `timezone` (or the viewer's zone), e.g. `Oct 11, 00:00`. */
export function formatMoment(iso: string, timezone?: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  try {
    return date.toLocaleString('en-US', {
      timeZone: timezone,
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  } catch {
    return date.toISOString();
  }
}

/** The first budget of `budgets` that currently refuses new starts. */
export const refusingBudget = (
  budgets: readonly BudgetView[],
): BudgetView | undefined =>
  budgets.find(
    (b) => b.enabled && b.action === 'stop' && b.current?.state === 'exceeded',
  );

/** The scope a budget covers, in words. */
export const scopeName = (budget: BudgetView): string =>
  budget.scopeName ?? (budget.scope === 'project' ? 'a project' : 'a user');

export interface BudgetForm {
  scope: BudgetScope;
  projectId: string;
  userId: string;
  period: BudgetPeriod;
  timezone: string;
  limit: string;
  /** Comma- or space-separated percentages. */
  thresholds: string;
  action: BudgetAction;
  enabled: boolean;
}

export const emptyBudgetForm = (timezone = 'UTC'): BudgetForm => ({
  scope: 'project',
  projectId: '',
  userId: '',
  period: 'month',
  timezone,
  limit: '',
  thresholds: BUDGET_DEFAULT_THRESHOLDS.join(', '),
  action: 'alert',
  enabled: true,
});

export const formFromBudget = (budget: BudgetView): BudgetForm => ({
  scope: budget.scope,
  projectId: budget.projectId ?? '',
  userId: budget.userId ?? '',
  period: budget.period,
  timezone: budget.timezone,
  limit: budget.limitUsd.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, ''),
  thresholds: budget.thresholds.join(', '),
  action: budget.action,
  enabled: budget.enabled,
});

/** `"50, 80"` → `[50, 80, 100]`; null for anything the API would refuse. */
export function parseThresholds(text: string): number[] | null {
  const parts = text.split(/[\s,]+/).filter((p) => p !== '');
  const numbers = parts.map((p) => (/^\d+$/.test(p) ? Number(p) : Number.NaN));
  if (numbers.some(Number.isNaN)) return null;
  return normalizeThresholds(numbers);
}

export type BudgetFormProblem =
  | 'scope_target'
  | 'limit'
  | 'limit_zero'
  | 'thresholds'
  | 'timezone';

export const BUDGET_FORM_PROBLEM_TEXT: Record<BudgetFormProblem, string> = {
  scope_target: 'Pick the project or the user the budget covers.',
  limit:
    'Enter the limit in dollars, e.g. 10 or 25.50 (up to 4 decimals, 10 digits).',
  limit_zero: 'The limit must be above zero.',
  thresholds:
    'Thresholds are whole percentages from 1 to 100, at most 10, e.g. 50, 80, 100.',
  timezone: 'Pick an IANA timezone, e.g. Europe/Berlin.',
};

/** Why the form cannot be sent, or null. `needsTarget` is the admin create form. */
export function budgetFormProblem(
  form: BudgetForm,
  needsTarget: boolean,
): BudgetFormProblem | null {
  if (needsTarget) {
    if (form.scope === 'project' && form.projectId === '') {
      return 'scope_target';
    }
    if (form.scope === 'user' && form.userId === '') return 'scope_target';
  }
  const limit = form.limit.trim();
  if (!BUDGET_LIMIT_PATTERN.test(limit)) return 'limit';
  if (Number(limit) <= 0) return 'limit_zero';
  if (parseThresholds(form.thresholds) === null) return 'thresholds';
  if (!isValidTimeZone(form.timezone)) return 'timezone';
  return null;
}

/** The body shared by both create routes; the form is valid when this is called. */
export function toCreateRequest(form: BudgetForm): BudgetCreateRequest {
  return {
    period: form.period,
    timezone: form.timezone,
    limitUsd: form.limit.trim(),
    thresholds: parseThresholds(form.thresholds) ?? undefined,
    action: form.action,
    enabled: form.enabled,
  };
}

/** `POST /admin/budgets` also names the scope. */
export function toAdminCreateRequest(form: BudgetForm) {
  return {
    ...toCreateRequest(form),
    scope: form.scope,
    ...(form.scope === 'project'
      ? { projectId: form.projectId }
      : { userId: form.userId }),
  };
}

/** Only what changed; an empty patch means there is nothing to save. */
export function toUpdateRequest(
  form: BudgetForm,
  budget: BudgetView,
): BudgetUpdateRequest {
  const next = toCreateRequest(form);
  const patch: BudgetUpdateRequest = {};
  if (next.period !== budget.period) patch.period = next.period;
  if (next.timezone !== budget.timezone) patch.timezone = next.timezone;
  if (Number(next.limitUsd) !== Number(budget.limitUsd)) {
    patch.limitUsd = next.limitUsd;
  }
  if (next.thresholds?.join(',') !== budget.thresholds.join(',')) {
    patch.thresholds = next.thresholds;
  }
  if (next.action !== budget.action) patch.action = next.action;
  if (next.enabled !== budget.enabled) patch.enabled = next.enabled;
  return patch;
}

export interface OverrideForm {
  /** `datetime-local` value, in the viewer's zone. */
  until: string;
  reason: string;
}

export type OverrideProblem = 'until' | 'until_range' | 'reason';

export const OVERRIDE_PROBLEM_TEXT: Record<OverrideProblem, string> = {
  until: 'Pick the time the override ends.',
  until_range:
    'The override must end in the future and no later than the period’s end.',
  reason: `Give a reason (at most ${BUDGET_OVERRIDE_REASON_MAX} characters). It is audited.`,
};

/** `datetime-local` text → instant; null when blank or not a date. */
export function parseLocalInstant(text: string): Date | null {
  if (text === '') return null;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function overrideProblem(
  form: OverrideForm,
  budget: BudgetView,
  now = new Date(),
): OverrideProblem | null {
  const until = parseLocalInstant(form.until);
  if (!until) return 'until';
  const end = budget.current ? new Date(budget.current.end) : null;
  if (until <= now || (end !== null && until > end)) return 'until_range';
  const reason = form.reason.trim();
  if (reason === '' || reason.length > BUDGET_OVERRIDE_REASON_MAX) {
    return 'reason';
  }
  return null;
}

export function toOverrideRequest(form: OverrideForm): BudgetOverrideRequest {
  return {
    until: (parseLocalInstant(form.until) ?? new Date()).toISOString(),
    reason: form.reason.trim(),
  };
}

/** `Date` → `datetime-local` text in the viewer's zone. */
export function toLocalInput(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** `budget_exceeded` (409) as its body, or null for any other error. */
export function budgetExceededOf(
  error: unknown,
): Pick<BudgetExceededBody, 'budgetId' | 'scope' | 'resetsAt'> | null {
  if (!(error instanceof ApiError) || error.status !== 409) return null;
  const body = error.body;
  if (!body || body.error !== BUDGET_ERROR.exceeded) return null;
  const { budgetId, scope, resetsAt } = body;
  if (typeof budgetId !== 'string' || typeof resetsAt !== 'string') {
    return null;
  }
  return {
    budgetId,
    scope: scope === 'user' ? 'user' : 'project',
    resetsAt,
  };
}

/** The sentence for a refused start; the reset time is in the viewer's zone. */
export function describeBudgetExceeded(
  exceeded: Pick<BudgetExceededBody, 'scope' | 'resetsAt'>,
): string {
  const whose = exceeded.scope === 'user' ? 'Your' : 'This project’s';
  return `${whose} budget is used up, so nothing new can start until it resets on ${formatMoment(exceeded.resetsAt)}. Running work continues. An administrator can lift the stop for this period.`;
}

/** A refused start as a sentence, or null when the error is something else. */
export function describeBudgetExceededError(error: unknown): string | null {
  const exceeded = budgetExceededOf(error);
  return exceeded ? describeBudgetExceeded(exceeded) : null;
}

const BUDGET_ERROR_SENTENCE: Record<string, string> = {
  [BUDGET_ERROR.notFound]:
    'The budget no longer exists, or you are not a member of the project. Refresh the list.',
  [BUDGET_ERROR.forbidden]: 'Your role does not allow changing budgets.',
  [BUDGET_ERROR.invalidArgs]:
    'The budget was rejected as invalid. Check the limit, the thresholds and the timezone.',
  [BUDGET_ERROR.duplicate]:
    'An enabled budget with the same scope and period already exists. Edit it or disable it first.',
  [BUDGET_ERROR.noOverride]:
    'There is nothing to override or revoke: the budget is not a stop budget, or no override is active.',
  [BUDGET_ERROR.notStop]: 'Only a stop budget can be overridden.',
};

/** Every budgets error as a sentence for the person. */
export function describeBudgetsError(error: unknown): string {
  const exceeded = describeBudgetExceededError(error);
  if (exceeded) return exceeded;
  if (error instanceof ApiError) {
    const sentence = BUDGET_ERROR_SENTENCE[error.code as string];
    if (sentence) return sentence;
    if (error.status === 404)
      return BUDGET_ERROR_SENTENCE[BUDGET_ERROR.notFound];
    if (error.status === 403)
      return BUDGET_ERROR_SENTENCE[BUDGET_ERROR.forbidden];
  }
  return describeError(error);
}

export const isBudgetAction = (value: string): value is BudgetAction =>
  (BUDGET_ACTIONS as readonly string[]).includes(value);

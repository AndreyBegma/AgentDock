import {
  BUDGET_SCOPES,
  BUDGET_STATES,
  type BudgetScope,
  type BudgetState,
} from '@nautelle/shared';
import type { ChipDef, FilterCodec } from '../filters/url-filters';
import { SCOPE_LABEL, STATE_LABEL } from './format';

/**
 * `/admin/budgets`' filters in the URL (#213): `?scope=project&state=exceeded`.
 * `''` is "any".
 */
export interface BudgetFilters {
  scope: BudgetScope | '';
  state: BudgetState | '';
}

export const EMPTY_BUDGET_FILTERS: BudgetFilters = { scope: '', state: '' };

const KEYS = ['scope', 'state'] as const;

/** What the URL says; an unknown value is "any". */
export function budgetFiltersFromSearch(
  params: URLSearchParams,
): BudgetFilters {
  const scope = params.get('scope');
  const state = params.get('state');
  return {
    scope: BUDGET_SCOPES.find((s) => s === scope) ?? '',
    state: BUDGET_STATES.find((s) => s === state) ?? '',
  };
}

/** `''` or `?…`; "any" is left out. */
export function budgetFiltersSearch(filters: BudgetFilters): string {
  const params = new URLSearchParams();
  if (filters.scope) params.set('scope', filters.scope);
  if (filters.state) params.set('state', filters.state);
  const text = params.toString();
  return text ? `?${text}` : '';
}

export const BUDGET_FILTER_CODEC: FilterCodec<BudgetFilters> = {
  keys: KEYS,
  parse: budgetFiltersFromSearch,
  search: budgetFiltersSearch,
};

export const BUDGET_CHIP_DEFS: ChipDef<BudgetFilters>[] = [
  {
    key: 'scope',
    label: (f) => (f.scope ? `Scope: ${SCOPE_LABEL[f.scope]}` : null),
    clear: { scope: '' },
  },
  {
    key: 'state',
    label: (f) => (f.state ? `State: ${STATE_LABEL[f.state]}` : null),
    clear: { state: '' },
  },
];

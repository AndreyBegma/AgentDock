import { describe, expect, test } from 'bun:test';
import { activeChips, clearAll } from '../filters/url-filters';
import {
  BUDGET_CHIP_DEFS,
  BUDGET_FILTER_CODEC,
  budgetFiltersFromSearch,
  budgetFiltersSearch,
} from './filters';

describe('budget filters in the URL', () => {
  test('reads a scope and a state', () => {
    expect(
      budgetFiltersFromSearch(new URLSearchParams('scope=user&state=exceeded')),
    ).toEqual({ scope: 'user', state: 'exceeded' });
  });

  test('an unknown value is "any"', () => {
    expect(
      budgetFiltersFromSearch(new URLSearchParams('scope=team&state=nope')),
    ).toEqual({ scope: '', state: '' });
  });

  test('writes only what is set', () => {
    expect(budgetFiltersSearch({ scope: '', state: '' })).toBe('');
    expect(budgetFiltersSearch({ scope: 'project', state: '' })).toBe(
      '?scope=project',
    );
  });

  test('round-trips', () => {
    const filters = { scope: 'project', state: 'exceeded' } as const;
    expect(
      BUDGET_FILTER_CODEC.parse(
        new URLSearchParams(BUDGET_FILTER_CODEC.search(filters)),
      ),
    ).toEqual(filters);
  });

  test('chips name the filters in force and Clear all empties them', () => {
    const filters = { scope: 'user', state: 'exceeded' } as const;
    const chips = activeChips(filters, BUDGET_CHIP_DEFS);
    expect(chips.map((c) => c.key)).toEqual(['scope', 'state']);
    expect(clearAll(BUDGET_CHIP_DEFS)).toEqual({ scope: '', state: '' });
  });
});

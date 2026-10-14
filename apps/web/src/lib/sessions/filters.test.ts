import { describe, expect, it } from 'bun:test';
import { activeChips, clearAll } from '../filters/url-filters';
import {
  moreSessionFilterCount,
  SESSION_FILTER_CODEC,
  sessionChipDefs,
  sessionFiltersFromSearch,
  sessionFiltersSearch,
} from './filters';
import { EMPTY_FILTERS } from './format';

const parse = (search: string) =>
  sessionFiltersFromSearch(new URLSearchParams(search));

describe('session filters in the URL', () => {
  it('reads nothing from an empty query', () => {
    expect(parse('')).toEqual(EMPTY_FILTERS);
  });

  it('round-trips every filter in a stable order', () => {
    const form = {
      projectId: 'p1',
      runtime: 'codex',
      origin: 'worker',
      fromDate: '2026-10-01',
      toDate: '2026-10-08',
      model: 'claude-opus-5-5',
      slot: 'i42',
      unassigned: false,
    };
    const search = sessionFiltersSearch(form);
    expect(parse(search)).toEqual(form);
    expect(search).toBe(
      '?project=p1&runtime=codex&origin=worker&from=2026-10-01&to=2026-10-08&model=claude-opus-5-5&slot=i42',
    );
  });

  it('drops an unknown runtime, origin or malformed day', () => {
    expect(parse('runtime=gpt&origin=unknown&from=yesterday')).toEqual(
      EMPTY_FILTERS,
    );
  });

  it('keeps unassigned as a flag', () => {
    expect(parse('unassigned=1').unassigned).toBe(true);
    expect(sessionFiltersSearch({ ...EMPTY_FILTERS, unassigned: true })).toBe(
      '?unassigned=1',
    );
  });

  it('owns the unassigned key so a change replaces it', () => {
    expect(SESSION_FILTER_CODEC.keys).toContain('unassigned');
    expect(SESSION_FILTER_CODEC.keys).toContain('project');
  });
});

describe('session filter chips', () => {
  const defs = sessionChipDefs((id) => `name of ${id}`);

  it('shows no chip while nothing is set', () => {
    expect(activeChips(EMPTY_FILTERS, defs)).toEqual([]);
  });

  it('names the project and hides it while unassigned wins', () => {
    const chips = (unassigned: boolean) =>
      activeChips({ ...EMPTY_FILTERS, projectId: 'p1', unassigned }, defs).map(
        (c) => c.label,
      );
    expect(chips(false)).toEqual(['Project: name of p1']);
    expect(chips(true)).toEqual(['No project']);
  });

  it('clears everything with Clear all', () => {
    const cleared = {
      ...parse('project=p1&runtime=claude&slot=i4&unassigned=1'),
      ...clearAll(defs),
    };
    expect(cleared).toEqual(EMPTY_FILTERS);
  });

  it('counts the More filters fields', () => {
    expect(moreSessionFilterCount(EMPTY_FILTERS)).toBe(0);
    expect(
      moreSessionFilterCount({
        ...EMPTY_FILTERS,
        slot: 'i4',
        fromDate: '2026-10-01',
        unassigned: true,
      }),
    ).toBe(3);
  });
});

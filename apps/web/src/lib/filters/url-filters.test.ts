import { describe, expect, test } from 'bun:test';
import {
  activeChips,
  type ChipDef,
  clearAll,
  mergeSearch,
} from './url-filters';

describe('mergeSearch', () => {
  test('replaces the codec keys and keeps the others', () => {
    expect(
      mergeSearch(
        'tab=budget&projectId=a&kind=bug',
        ['projectId', 'kind'],
        '?projectId=b',
      ),
    ).toBe('?tab=budget&projectId=b');
  });

  test('empty when nothing is left', () => {
    expect(mergeSearch('projectId=a', ['projectId'], '')).toBe('');
  });

  test('a key written twice by the codec stays twice', () => {
    expect(mergeSearch('', ['x'], '?x=1&x=2')).toBe('?x=1&x=2');
  });
});

interface F {
  projectId: string;
  status: string;
}

const DEFS: ChipDef<F>[] = [
  {
    key: 'projectId',
    label: (f) => (f.projectId ? `Project: ${f.projectId}` : null),
    clear: { projectId: '' },
  },
  {
    key: 'status',
    label: (f) => (f.status ? `Status: ${f.status}` : null),
    clear: { status: '' },
  },
];

describe('activeChips', () => {
  test('only the filters in force, in the given order', () => {
    expect(activeChips({ projectId: '', status: 'merged' }, DEFS)).toEqual([
      { key: 'status', label: 'Status: merged', clear: { status: '' } },
    ]);
  });

  test('nothing set is no chip', () => {
    expect(activeChips({ projectId: '', status: '' }, DEFS)).toEqual([]);
  });
});

test('clearAll merges every chip clear', () => {
  expect(clearAll(DEFS)).toEqual({ projectId: '', status: '' });
});

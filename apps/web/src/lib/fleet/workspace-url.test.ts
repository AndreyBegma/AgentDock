import { describe, expect, test } from 'bun:test';
import {
  blur,
  closeAll,
  closeSlot,
  EMPTY_WORKSPACE,
  OPEN_MAX,
  openSlot,
  parseWorkspace,
  setView,
  slotHref,
  toSearch,
  type WorkspaceState,
} from './workspace-url';

const parse = (query: string) => parseWorkspace(new URLSearchParams(query));

describe('parseWorkspace', () => {
  test('reads the open tabs, the focus and the view', () => {
    expect(parse('open=i42,i43&focus=i42&view=canvas')).toEqual({
      open: ['i42', 'i43'],
      focus: 'i42',
      view: 'canvas',
    });
  });

  test('nothing is the empty workspace', () => {
    expect(parse('')).toEqual(EMPTY_WORKSPACE);
  });

  test('drops what is not a slot name, and repeats', () => {
    expect(parse('open=i42,,I43,../x,i42,a b,i44').open).toEqual([
      'i42',
      'i44',
    ]);
  });

  test('a focus not among the open tabs is no focus; the orchestrator always may be', () => {
    expect(parse('open=i42&focus=i43').focus).toBeNull();
    expect(parse('focus=orchestrator').focus).toBe('orchestrator');
  });

  test('caps the tabs a pasted link can open', () => {
    const many = Array.from({ length: OPEN_MAX + 5 }, (_, i) => `s${i}`);
    expect(parse(`open=${many.join(',')}`).open).toHaveLength(OPEN_MAX);
  });

  test('an unknown view is the list', () => {
    expect(parse('view=grid').view).toBe('list');
  });
});

describe('toSearch', () => {
  test('writes commas plainly and keeps other parameters', () => {
    expect(
      toSearch({ open: ['i42', 'i43'], focus: 'i42', view: 'list' }, [
        ['tab', 'chat'],
        ['open', 'stale'],
      ]),
    ).toBe('?tab=chat&open=i42,i43&focus=i42');
  });

  test('the empty workspace is no query at all', () => {
    expect(toSearch(EMPTY_WORKSPACE)).toBe('');
  });

  test('round-trips', () => {
    const state: WorkspaceState = {
      open: ['a', 'b-1'],
      focus: 'b-1',
      view: 'canvas',
    };
    expect(parse(toSearch(state).slice(1))).toEqual(state);
  });
});

describe('transitions', () => {
  test('opening adds a tab and brings it to the front; reopening only focuses', () => {
    const one = openSlot(EMPTY_WORKSPACE, 'a');
    const two = openSlot(one, 'b');
    expect(two).toEqual({ open: ['a', 'b'], focus: 'b', view: 'list' });
    expect(openSlot(two, 'a')).toEqual({ ...two, focus: 'a' });
  });

  test('the orchestrator focuses without a tab', () => {
    expect(openSlot(EMPTY_WORKSPACE, 'orchestrator')).toEqual({
      ...EMPTY_WORKSPACE,
      focus: 'orchestrator',
    });
  });

  test('at the cap the oldest tab makes room', () => {
    let state = EMPTY_WORKSPACE;
    for (let i = 0; i < OPEN_MAX; i += 1) state = openSlot(state, `s${i}`);
    const next = openSlot(state, 'new');
    expect(next.open).toHaveLength(OPEN_MAX);
    expect(next.open[0]).toBe('s1');
    expect(next.focus).toBe('new');
  });

  test('ignores a name that is not a slot', () => {
    expect(openSlot(EMPTY_WORKSPACE, 'Bad Name')).toBe(EMPTY_WORKSPACE);
  });

  test('closing the front tab focuses its neighbour', () => {
    const state = {
      open: ['a', 'b', 'c'],
      focus: 'b',
      view: 'list',
    } as const;
    expect(closeSlot({ ...state, open: [...state.open] }, 'b').focus).toBe('c');
    expect(
      closeSlot({ ...state, open: [...state.open], focus: 'c' }, 'c').focus,
    ).toBe('b');
    expect(closeSlot({ open: ['a'], focus: 'a', view: 'list' }, 'a')).toEqual({
      open: [],
      focus: null,
      view: 'list',
    });
  });

  test('closing a background tab keeps the focus', () => {
    expect(
      closeSlot({ open: ['a', 'b'], focus: 'b', view: 'list' }, 'a'),
    ).toEqual({ open: ['b'], focus: 'b', view: 'list' });
  });

  test('closing the orchestrator clears the focus', () => {
    expect(
      closeSlot(
        { open: ['a'], focus: 'orchestrator', view: 'list' },
        'orchestrator',
      ),
    ).toEqual({ open: ['a'], focus: null, view: 'list' });
  });

  test('collapse all, blur and the view', () => {
    const state = { open: ['a', 'b'], focus: 'a', view: 'canvas' } as const;
    const copy = { ...state, open: [...state.open] };
    expect(closeAll(copy)).toEqual({ open: [], focus: null, view: 'canvas' });
    expect(blur(copy)).toEqual({ ...copy, focus: null });
    expect(setView(copy, 'list').view).toBe('list');
  });
});

describe('slotHref', () => {
  test('opens the slot in front, and parses back to it', () => {
    const href = slotHref('p1', 'i42');
    expect(href).toBe('/projects/p1/fleet?open=i42&focus=i42');
    expect(parse(href.split('?')[1] ?? '')).toEqual({
      open: ['i42'],
      focus: 'i42',
      view: 'list',
    });
  });

  test('a name that is not a slot opens the Fleet alone', () => {
    expect(slotHref('p1', 'Not A Slot')).toBe('/projects/p1/fleet');
  });
});

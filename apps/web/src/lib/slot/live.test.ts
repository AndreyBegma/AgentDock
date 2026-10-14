import { describe, expect, test } from 'bun:test';
import { parseFleetChange, refetchFor } from './live';

describe('parseFleetChange', () => {
  test('reads each known kind', () => {
    for (const kind of ['slot', 'round', 'orchestrator', 'conversation']) {
      expect(parseFleetChange({ kind, id: 'x' })).toEqual({
        kind: kind as 'slot',
        id: 'x',
      });
    }
  });

  test('anything else is null', () => {
    expect(parseFleetChange(null)).toBeNull();
    expect(parseFleetChange('slot')).toBeNull();
    expect(parseFleetChange({ kind: 'slot' })).toBeNull();
    expect(parseFleetChange({ kind: 'pane', id: 'x' })).toBeNull();
  });
});

describe('refetchFor', () => {
  test('this run moved: detail, chat and graph', () => {
    expect(refetchFor({ kind: 'slot', id: 's1' }, 's1')).toEqual({
      detail: true,
      conversation: true,
      graph: true,
    });
  });

  test('another run moved: only the graph', () => {
    expect(refetchFor({ kind: 'slot', id: 's2' }, 's1')).toEqual({
      detail: false,
      conversation: false,
      graph: true,
    });
  });

  test('a message to this run: only the conversation', () => {
    expect(refetchFor({ kind: 'conversation', id: 's1' }, 's1')).toEqual({
      detail: false,
      conversation: true,
      graph: false,
    });
    expect(
      refetchFor({ kind: 'conversation', id: 's2' }, 's1').conversation,
    ).toBe(false);
  });

  test('rounds and the orchestrator move the graph only', () => {
    for (const kind of ['round', 'orchestrator'] as const) {
      expect(refetchFor({ kind, id: 'p1' }, 's1')).toEqual({
        detail: false,
        conversation: false,
        graph: true,
      });
    }
  });

  test('with no run known yet, any slot change may be its first run', () => {
    expect(refetchFor({ kind: 'slot', id: 'new' }, undefined).detail).toBe(
      true,
    );
  });
});

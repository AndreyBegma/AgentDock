import { describe, expect, it } from 'bun:test';
import { stackDesignPath } from './naming';
import {
  currentStage,
  isStackGated,
  stackColumn,
  stackLabel,
  stackStageText,
  stageLinks,
} from './stacks';

describe('stacks (#480, ADR-0044)', () => {
  it('a stack sits in the column of its least advanced unfinished card', () => {
    expect(stackColumn(['completed', 'in_progress', 'todo'])).toBe('todo');
    expect(stackColumn(['completed', 'finished', 'in_progress'])).toBe(
      'in_progress',
    );
    expect(stackColumn(['completed', 'completed'])).toBe('completed');
    expect(stackColumn([])).toBe('todo');
  });

  it('the current stage is the first with a card not in Completed', () => {
    expect(
      currentStage([
        { position: 1, columns: ['todo'] },
        { position: 0, columns: ['completed', 'in_progress'] },
      ]),
    ).toBe(0);
    expect(
      currentStage([
        { position: 0, columns: ['completed'] },
        { position: 1, columns: ['todo'] },
      ]),
    ).toBe(1);
    expect(currentStage([{ position: 0, columns: ['completed'] }])).toBeNull();
  });

  it('every card of a stage depends on every card of the stage before', () => {
    expect(stageLinks([['a', 'b'], ['c'], ['d', 'e']])).toEqual([
      ['c', 'a'],
      ['c', 'b'],
      ['d', 'c'],
      ['e', 'c'],
    ]);
    // An empty stage is skipped: the next waits on the last filled one.
    expect(stageLinks([['a'], [], ['b']])).toEqual([['b', 'a']]);
    expect(stageLinks([['a', 'b']])).toEqual([]);
  });

  it('only a needed design that is not approved holds the stack', () => {
    expect(isStackGated(null)).toBe(false);
    expect(isStackGated({ needed: true, status: 'reviewing' })).toBe(true);
    expect(isStackGated({ needed: true, status: 'approved' })).toBe(false);
    expect(isStackGated({ needed: false, status: 'idle' })).toBe(false);
  });

  it('names a stack, its stage and its design files', () => {
    expect(stackLabel(3)).toBe('S-3');
    expect(
      stackStageText({
        id: 's',
        number: 3,
        label: 'S-3',
        title: 'Redesign',
        column: 'todo',
        accepted: 1,
        total: 5,
        currentStage: 0,
        stages: [
          { position: 0, title: 'Components', cards: [1, 2] },
          { position: 1, title: '', cards: [3] },
        ],
        design: null,
        costUsd: null,
        run: null,
      }),
    ).toBe('Stage 1 of 2 · Components');
    expect(
      stackDesignPath(
        'docs/specs/',
        { number: 3, title: 'Redesign the Settings page' },
        1,
        'mockup',
      ),
    ).toBe(
      'docs/specs/stacks/S-3-redesign-the-settings-page/design/1/mockup.html',
    );
    expect(
      stackDesignPath(null, { number: 3, title: 'Redesign' }, 2, 'page'),
    ).toBe('docs/design/stacks/S-3-redesign/2/page.html');
  });
});

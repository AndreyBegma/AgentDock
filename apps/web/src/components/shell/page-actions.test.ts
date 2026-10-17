import { describe, expect, test } from 'bun:test';
import { CalendarPlus, Plus, SquarePen } from 'lucide-react';
import { capsuleAction, type PageAction } from './page-actions';

const action = (id: string, operatorOnly?: boolean): PageAction => ({
  id,
  label: id,
  icon: Plus,
  onSelect: () => undefined,
  operatorOnly,
});

const newWork: PageAction = {
  id: 'new-work',
  label: 'New work',
  icon: SquarePen,
  onSelect: () => undefined,
  operatorOnly: true,
};

const ids = (result: ReturnType<typeof capsuleAction>) =>
  result.kind === 'none'
    ? []
    : result.kind === 'run'
      ? [result.action.id]
      : result.actions.map((each) => each.id);

describe('capsuleAction', () => {
  test('one registered action runs directly', () => {
    const result = capsuleAction([action('new-issue', true)], 'operator', null);
    expect(result.kind).toBe('run');
    expect(ids(result)).toEqual(['new-issue']);
  });

  test('two or more registered actions open a sheet listing them', () => {
    const result = capsuleAction(
      [
        action('new-issue', true),
        { ...action('new-schedule', true), icon: CalendarPlus },
      ],
      'admin',
      newWork,
    );
    expect(result.kind).toBe('sheet');
    expect(ids(result)).toEqual(['new-issue', 'new-schedule']);
  });

  test("the page's own actions replace the fallback", () => {
    expect(
      ids(capsuleAction([action('new-issue')], 'operator', newWork)),
    ).toEqual(['new-issue']);
  });

  test('inside a project, a page with none falls back to New work', () => {
    const result = capsuleAction([], 'operator', newWork);
    expect(result.kind).toBe('run');
    expect(ids(result)).toEqual(['new-work']);
  });

  test('outside a project, a page with none gets no +', () => {
    expect(capsuleAction([], 'admin', null)).toEqual({ kind: 'none' });
  });

  test('a viewer never sees an operator-only action', () => {
    const result = capsuleAction(
      [action('new-issue', true), action('export')],
      'viewer',
      newWork,
    );
    expect(result.kind).toBe('run');
    expect(ids(result)).toEqual(['export']);
  });

  test('a viewer with nothing left gets no +', () => {
    expect(capsuleAction([], 'viewer', newWork)).toEqual({ kind: 'none' });
    expect(
      capsuleAction([action('new-issue', true)], 'viewer', newWork),
    ).toEqual({ kind: 'none' });
  });
});

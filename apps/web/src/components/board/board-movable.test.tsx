import { describe, expect, test } from 'bun:test';
import { Board } from '@andrewbehma/glass-ui/board';
import type { BoardPlanTaskView } from '@nautelle/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { boardView, card } from '../../lib/board/fixtures';
import { columnsOf } from '../../lib/board/format';
import {
  boardItems,
  toPlanItem,
  type WorkBoardItem,
} from '../../lib/board/plan-tasks';

const task: BoardPlanTaskView = {
  planId: 'plan-1',
  planTitle: 'Onboarding v2',
  taskId: 'task-t1',
  key: 't1',
  title: 'Task t1',
  kind: 'feature',
  column: 'todo',
  status: 'draft',
  issue: null,
  design: null,
  summary: '',
  updatedAt: '2026-10-14T10:00:00.000Z',
};

/** The Board as the Work board hands it items: a card and a plan task in To Do. */
const html = () => {
  const view = boardView([card(1, 'todo')]);
  const items = boardItems(view, [task]);
  return renderToStaticMarkup(
    <Board<WorkBoardItem>
      aria-label="Project board"
      columns={columnsOf(view).map((c) => ({
        id: c.column,
        title: c.column,
        cards: items.get(c.column) ?? [],
      }))}
      onMove={() => undefined}
      renderCard={(item) => <span>{item.label}</span>}
    />,
  );
};

/** The opening tag of the card `li` holding `text`. */
const cardTag = (markup: string, text: string) => {
  const start = markup.lastIndexOf('<li', markup.indexOf(text));
  return markup.slice(start, markup.indexOf('>', start) + 1);
};

describe('the Board drags cards, not plan tasks (C-44)', () => {
  const planLabel = toPlanItem(task).label;

  test('a plan task is not a drag source and has no move menu', () => {
    const markup = html();
    expect(cardTag(markup, planLabel)).toContain('draggable="false"');
    // Its only menu entries would be moves, so it gets no trigger at all.
    expect(markup).not.toContain(`${planLabel} actions`);
  });

  test('a card still is, with its move menu', () => {
    const markup = html();
    const cardLabel = 'C-1 ';
    expect(cardTag(markup, cardLabel)).toContain('draggable="true"');
    expect(markup).toMatch(/aria-label="C-1 [^"]* actions"/);
  });
});

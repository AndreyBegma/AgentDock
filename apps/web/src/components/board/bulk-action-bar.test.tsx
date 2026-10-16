import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { card, round } from '../../lib/board/fixtures';
import { bulkBarActions } from './bulk-action-bar';
import { CardFace } from './card-face';

const actions = (cards: ReturnType<typeof card>[]) =>
  Object.fromEntries(
    bulkBarActions(cards, false, () => undefined).map((a) => [a.id, a]),
  );

describe('bulkBarActions', () => {
  const selected = [
    card(1, 'finished'),
    card(2, 'finished'),
    card(3, 'in_progress', { round: round('running') }),
    card(4, 'todo'),
  ];

  test('each action carries how many of the selection it applies to', () => {
    const a = actions(selected);
    expect([a.complete.count, a.complete.of]).toEqual([2, 4]);
    expect([a.todo.count, a.todo.of]).toEqual([2, 4]);
    expect([a.finished.count, a.finished.of]).toEqual([1, 4]);
    expect([a.delete.count, a.delete.of]).toEqual([3, 4]);
  });

  test('an action that applies to none has count 0, which the bar disables', () => {
    const a = actions([card(1, 'todo'), card(2, 'todo')]);
    expect(a.finished.count).toBe(0);
    expect(a.complete.count).toBe(0);
    expect(a.delete.count).toBe(2);
  });

  test('delete is the danger action, and busy disables all', () => {
    expect(actions(selected).delete.tone).toBe('danger');
    expect(
      bulkBarActions(selected, true, () => undefined).every((a) => a.disabled),
    ).toBe(true);
  });
});

describe('CardFace selection', () => {
  const face = (
    selection: { selected: boolean; selecting: boolean } | undefined,
    column: 'finished' | 'inbox' = 'finished',
  ) =>
    renderToStaticMarkup(
      <CardFace
        projectId="p1"
        canOperate
        selection={
          selection ? { ...selection, onToggle: () => undefined } : undefined
        }
        onOpen={() => undefined}
        card={card(7, column)}
      />,
    );

  test('has no checkbox without a selection', () => {
    expect(face(undefined)).not.toContain('type="checkbox"');
  });

  test('has a checkbox, checked when the card is selected', () => {
    const idle = face({ selected: false, selecting: false });
    expect(idle).toContain('aria-label="Select C-7"');
    expect(idle).not.toContain('checked=""');
    const picked = face({ selected: true, selecting: true });
    expect(picked).toContain('checked=""');
    expect(picked).toContain('border-accent');
  });

  test('a suggestion has no checkbox, and says why while selecting', () => {
    const html = face({ selected: false, selecting: true }, 'inbox');
    expect(html).not.toContain('type="checkbox"');
    expect(html).toContain('accepted or dismissed one by one');
  });
});

import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { card, round } from '../../lib/board/fixtures';
import { BulkActionBar } from './bulk-action-bar';
import { CardFace } from './card-face';

const bar = (cards: ReturnType<typeof card>[]) =>
  renderToStaticMarkup(
    <BulkActionBar
      selected={cards}
      busy={false}
      onClear={() => undefined}
      onAction={() => undefined}
    />,
  );

/** The button whose label starts with `label`: its markup. */
const button = (html: string, label: string) => {
  const match = html.match(new RegExp(`<button[^>]*>${label}.*?</button>`));
  if (!match) throw new Error(`no ${label} button in ${html}`);
  return match[0];
};

describe('BulkActionBar', () => {
  const selected = [
    card(1, 'finished'),
    card(2, 'finished'),
    card(3, 'in_progress', { round: round('running') }),
    card(4, 'todo'),
  ];

  test('says how many are selected and offers Clear', () => {
    const html = bar(selected);
    expect(html).toContain('>4<');
    expect(html).toContain('selected');
    expect(html).toContain('Clear');
  });

  test('each action shows how many of the selection it applies to', () => {
    const html = bar(selected);
    expect(button(html, 'Move to Completed')).toContain('2 of 4');
    expect(button(html, 'Move to To Do')).toContain('2 of 4');
    expect(button(html, 'Mark finished')).toContain('1 of 4');
    expect(button(html, 'Delete')).toContain('3 of 4');
  });

  test('an action that applies to none is disabled', () => {
    const html = bar([card(1, 'todo'), card(2, 'todo')]);
    expect(button(html, 'Mark finished')).toContain('disabled');
    expect(button(html, 'Move to Completed')).toContain('disabled');
    expect(button(html, 'Delete')).not.toContain('disabled=""');
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

import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { CardTabs, DEFAULT_CARD_TAB, visibleCardTabs } from './card-tabs';

const panels = {
  overview: <p>Overview body</p>,
  rounds: <p>Rounds body</p>,
  files: <p>Files body</p>,
  edit: <p>Edit body</p>,
};

const render = (
  tab: Parameters<typeof CardTabs>[0]['tab'],
  shown: Parameters<typeof CardTabs>[0]['panels'] = panels,
  roundCount = 3,
) =>
  renderToStaticMarkup(
    <CardTabs
      tab={tab}
      onTabChange={() => {}}
      panels={shown}
      roundCount={roundCount}
    />,
  );

describe('Card tabs (#836)', () => {
  test('a card opens on Overview', () => {
    expect(DEFAULT_CARD_TAB).toBe('overview');
  });

  test('the four tabs are ARIA tabs in a labelled tablist, the selected one in the tab order', () => {
    const html = render('overview');
    expect(html).toContain('role="tablist"');
    expect(html).toContain('aria-label="Card sections"');
    expect(html.match(/role="tab"/g)?.length).toBe(4);
    expect(html.match(/aria-selected="true"/g)?.length).toBe(1);
    expect(html.match(/tabindex="0"/g)?.length).toBe(1);
    expect(html).toContain('Overview');
    expect(html).toContain('Rounds (3)');
    expect(html).toContain('Files');
    expect(html).toContain('Edit');
  });

  test('switching the tab switches the panel content', () => {
    const overview = render('overview');
    expect(overview).toContain('Overview body');
    expect(overview).not.toContain('Rounds body');
    expect(overview).not.toContain('Files body');

    const rounds = render('rounds');
    expect(rounds).toContain('Rounds body');
    expect(rounds).not.toContain('Overview body');

    expect(render('files')).toContain('Files body');
  });

  test('the Edit form stays mounted while another tab shows, so typing is not lost', () => {
    const html = render('rounds');
    expect(html).toContain('Edit body');
    expect(html).toContain('Rounds body');
  });

  test('a section with nothing to show has no tab', () => {
    const html = render('overview', {
      ...panels,
      rounds: null,
      files: null,
    });
    expect(html.match(/role="tab"/g)?.length).toBe(2);
    expect(html).not.toContain('Rounds');
    expect(html).not.toContain('Files');
    expect(visibleCardTabs({ ...panels, rounds: null, files: false })).toEqual([
      'overview',
      'edit',
    ]);
  });

  test('a selection whose tab is hidden falls back to Overview', () => {
    const html = render('rounds', { ...panels, rounds: null });
    expect(html).toContain('Overview body');
    expect(html).not.toContain('Rounds body');
  });

  test('no count beside Rounds until there is a round', () => {
    expect(render('overview', panels, 0)).not.toContain('Rounds (');
  });
});

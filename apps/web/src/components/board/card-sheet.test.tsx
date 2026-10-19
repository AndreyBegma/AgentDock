import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { cardSheetFooter, cardSheetSide, focusSheetTitle } from './card-sheet';

interface Fake {
  title: { tabIndex: number; focused: boolean; focusOptions?: unknown };
  anchor: Element;
}

/** A sheet as Radix renders it: a dialog labelled by its title, an action inside. */
function fakeSheet(labelledBy: string | null, titleId: string | null): Fake {
  const title = {
    tabIndex: 0,
    focused: false,
    focusOptions: undefined as unknown,
    focus(options?: unknown) {
      this.focused = true;
      this.focusOptions = options;
    },
  };
  const dialog = {
    getAttribute: (name: string) =>
      name === 'aria-labelledby' ? labelledBy : null,
  };
  const anchor = {
    closest: (selector: string) =>
      selector === '[role="dialog"]' ? dialog : null,
    ownerDocument: {
      getElementById: (id: string) => (id === titleId ? title : null),
    },
  };
  return { title, anchor: anchor as unknown as Element };
}

describe('Card sheet initial focus (#397)', () => {
  test('focus goes to the sheet title, not to an action button', () => {
    const { title, anchor } = fakeSheet('title-1', 'title-1');
    expect(focusSheetTitle(anchor)).toBe(true);
    expect(title.focused).toBe(true);
    expect(title.tabIndex).toBe(-1);
    expect(title.focusOptions).toEqual({ preventScroll: true });
  });

  test('without a labelled dialog nothing is focused', () => {
    const { title, anchor } = fakeSheet(null, 'title-1');
    expect(focusSheetTitle(anchor)).toBe(false);
    expect(focusSheetTitle(null)).toBe(false);
    expect(title.focused).toBe(false);
  });

  test('a title that is not in the document is left alone', () => {
    const { title, anchor } = fakeSheet('missing', 'title-1');
    expect(focusSheetTitle(anchor)).toBe(false);
    expect(title.focused).toBe(false);
  });
});

describe('Card sheet on a phone (#680)', () => {
  const html = (node: ReturnType<typeof cardSheetFooter>) =>
    renderToStaticMarkup(node);

  test('a phone gets a bottom sheet, with the grabber and the scrim; lg up keeps the right edge', () => {
    expect(cardSheetSide(true)).toBe('bottom');
    expect(cardSheetSide(false)).toBe('right');
  });

  test('closing is one tap on the shared bar, Close opposite Open card', () => {
    const footer = html(
      cardSheetFooter({
        narrow: true,
        actions: <button type="submit">Save</button>,
        pageHref: '/projects/p/board/cards/7',
        onClose: () => {},
      }),
    );
    expect(footer).toContain('data-phone-back-bar');
    expect(footer).toContain('aria-label="Close"');
    expect(footer).toContain('h-(--size-tap)');
    expect(footer).toContain('href="/projects/p/board/cards/7"');
    expect(footer).toContain('Open card');
    expect(footer).toContain('Save');
    // Inline in the sheet's footer, so it rides the sheet rather than the page.
    expect(footer).not.toContain('fixed');
    expect(footer.indexOf('Save')).toBeLessThan(footer.indexOf('Close'));
  });

  test('a suggestion or a loading sheet still gets Close, without Open card', () => {
    const footer = html(cardSheetFooter({ narrow: true, onClose: () => {} }));
    expect(footer).toContain('aria-label="Close"');
    expect(footer).not.toContain('Open card');
  });

  test('desktop is unchanged: the actions alone, or no footer', () => {
    const footer = html(
      cardSheetFooter({
        narrow: false,
        actions: <button type="submit">Save</button>,
        pageHref: '/projects/p/board/cards/7',
        onClose: () => {},
      }),
    );
    expect(footer).toBe(
      '<div class="flex items-center justify-end gap-2"><button type="submit">Save</button></div>',
    );
    expect(
      cardSheetFooter({ narrow: false, onClose: () => {} }),
    ).toBeUndefined();
  });
});

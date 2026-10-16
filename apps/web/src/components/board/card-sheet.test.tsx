import { describe, expect, test } from 'bun:test';
import { focusSheetTitle } from './card-sheet';

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

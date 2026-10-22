import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { card as fixtureCard } from '../../lib/board/fixtures';
import {
  CardBranchLine,
  cardSheetFooter,
  cardSheetSide,
  EscalationRow,
  focusSheetTitle,
  PrTargetBanner,
  RunMoney,
} from './card-sheet';

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

describe('Card sheet PR target (#709)', () => {
  const banner = (merged: boolean | null) =>
    renderToStaticMarkup(
      <PrTargetBanner
        target={
          merged === null
            ? { branch: 'develop', stackedOn: null }
            : {
                branch: 'feat/281-the-dependency',
                stackedOn: { number: 281, label: 'C-281', merged },
              }
        }
      />,
    );

  test('a PR into the base shows no banner', () => {
    expect(banner(null)).toBe('');
  });

  test('a stacked PR names the dependency branch it goes into', () => {
    const html = banner(false);
    expect(html).toContain('C-281’s branch (feat/281-the-dependency)');
    expect(html).not.toContain('already merged');
  });

  test('warns when the dependency’s own PR has already merged', () => {
    const html = banner(true);
    expect(html).toContain('C-281’s own pull request has already merged');
    expect(html).toContain('retarget it on GitHub');
  });
});

describe('Card sheet PR target after a retarget on GitHub (#722)', () => {
  const branch = 'feat/722-the-page';
  const stacked = {
    branch: 'feat/696-the-shell',
    stackedOn: { number: 282, label: 'C-282', merged: false },
  };
  // The API clears the stored base once GitHub reports the PR on the base.
  const retargeted = { branch: 'develop', stackedOn: null };
  const sheet = (target: typeof stacked | typeof retargeted) =>
    renderToStaticMarkup(
      <>
        <CardBranchLine branch={branch} target={target} />
        <PrTargetBanner target={target} />
      </>,
    );

  test('a stacked PR shows the dependency branch it goes into', () => {
    const html = sheet(stacked);
    expect(html).toContain('into C-282’s branch');
    expect(html).toContain('(feat/696-the-shell)');
  });

  test('once moved onto develop, the sheet shows develop and no stacked banner', () => {
    const html = sheet(retargeted);
    expect(html).toContain(branch);
    expect(html).toContain('→ into develop');
    expect(html).toContain('The pull request goes into develop');
    expect(html).not.toContain('C-282');
    expect(html).not.toContain('feat/696-the-shell');
  });

  test('no branch yet, no line', () => {
    expect(
      renderToStaticMarkup(<CardBranchLine branch={null} target={null} />),
    ).toBe('');
  });
});

describe('Card sheet escalation row (#750 D9, D10)', () => {
  const escalation = {
    reason: 'misclassified' as const,
    note: 'The card needs a migration.',
    at: '2026-10-21T12:00:00.000Z',
  };
  const row = (model: string | null) =>
    renderToStaticMarkup(
      <EscalationRow card={{ model }} escalation={escalation} />,
    );

  test('a relaunched card records the escalation with its note', () => {
    const html = row(null);
    expect(html).toContain('Escalated to Opus · misclassified');
    expect(html).toContain('The card needs a migration.');
    expect(html).not.toContain('asks for Opus');
  });

  test("over a person's sonnet override the worker's ask is shown instead", () => {
    const html = row('sonnet');
    expect(html).toContain('The worker asks for Opus: misclassified');
    expect(html).toContain('The card needs a migration.');
    expect(html).not.toContain('Escalated to Opus');
  });
});

describe('Card sheet Run row saving (#778)', () => {
  const tokenSaved = { estimateUsd: 0.41, estimateTokens: 103_200 };
  const money = (extra: Parameters<typeof fixtureCard>[2]) =>
    renderToStaticMarkup(
      <RunMoney card={fixtureCard(7, 'completed', extra)} />,
    );

  test('the saving follows the cost, with its tokens title', () => {
    const html = money({ costUsd: '3.18', tokenSaved });
    expect(html).toContain('$3.18');
    expect(html).toContain('saved ≈');
    expect(html).toContain('title="Token saver kept');
    expect(html.indexOf('$3.18')).toBeLessThan(html.indexOf('saved ≈'));
  });

  test('a saving without a cost stands alone', () => {
    const html = money({ costUsd: null, tokenSaved });
    expect(html).toContain('saved ≈');
    expect(html).not.toContain('$3.18');
  });

  test('no tokenSaved, or one that saved nothing, draws nothing for it', () => {
    expect(money({ costUsd: '3.18', tokenSaved: null })).not.toContain('saved');
    expect(
      money({
        costUsd: null,
        tokenSaved: { estimateUsd: 0, estimateTokens: 0 },
      }),
    ).toBe('');
    expect(money({ costUsd: null, tokenSaved: null })).toBe('');
  });
});

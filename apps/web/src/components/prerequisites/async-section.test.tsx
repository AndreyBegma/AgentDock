import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Section } from '../../lib/section/use-section';
import { AsyncSection } from './async-section';

const ready: Section<string[]> = {
  data: ['a'],
  error: null,
  loading: false,
  retry: () => undefined,
  setData: () => undefined,
};

const render = (className?: string) =>
  renderToStaticMarkup(
    <AsyncSection
      section={ready}
      unavailable={{ title: 'Down' }}
      empty={null}
      className={className}
    >
      {() => <p>data</p>}
    </AsyncSection>,
  );

describe('AsyncSection wrapper', () => {
  test('stacks the data in a column by default', () => {
    expect(render()).toBe('<div class="flex flex-col gap-3"><p>data</p></div>');
  });

  // #384: without these the wrapper took the Board's height and its columns never scrolled.
  test('takes the caller’s classes, so a filling page can pass min-h-0 flex-1', () => {
    expect(render('min-h-0 flex-1')).toStartWith(
      '<div class="flex flex-col gap-3 min-h-0 flex-1">',
    );
  });
});

import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { boardCardPageHref } from '../../lib/board/href';
import { CardDescription } from './card-description';
import { CardNotFound } from './card-not-found';

const BODY = [
  '## Acceptance',
  '',
  '- [ ] a task',
  '',
  'Use `inline` code and [a link](https://example.com).',
  '',
  '```ts',
  'const x = 1;',
  '```',
].join('\n');

const render = (over: Partial<Parameters<typeof CardDescription>[0]> = {}) =>
  renderToStaticMarkup(
    <CardDescription
      body={BODY}
      editing={false}
      canOperate
      rows={8}
      onChange={() => {}}
      onToggle={() => {}}
      {...over}
    />,
  );

describe('CardDescription (#431)', () => {
  test('renders the Markdown by default', () => {
    const html = render();
    expect(html).toContain('Acceptance</h');
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('<code');
    expect(html).toContain('<pre');
    expect(html).toContain('href="https://example.com"');
    expect(html).not.toContain('<textarea');
    expect(html).toContain('>Edit<');
  });

  test('a /\\host link in the body is not followed (spec 164)', () => {
    const html = render({ body: 'See [the docs](/\\evil.com).' });
    expect(html).toContain('the docs');
    expect(html).not.toContain('evil.com"');
    expect(html).not.toContain('<a ');
  });

  test('Edit shows the textarea with the raw text, and offers Preview', () => {
    const html = render({ editing: true });
    expect(html).toContain('<textarea');
    expect(html).toContain('## Acceptance');
    expect(html).toContain('>Preview<');
  });

  test('a viewer sees it rendered, with no Edit', () => {
    const html = render({ canOperate: false, editing: true });
    expect(html).not.toContain('<textarea');
    expect(html).not.toContain('>Edit<');
    expect(html).toContain('Acceptance</h');
  });
});

describe('CardNotFound (#431)', () => {
  test('says so and links back to the board', () => {
    const html = renderToStaticMarkup(<CardNotFound projectId="p1" />);
    expect(html).toContain('Card not found');
    expect(html).toContain('href="/projects/p1/board"');
    expect(html).toContain('Back to the board');
  });
});

describe('boardCardPageHref', () => {
  test('is the card page', () => {
    expect(boardCardPageHref('p1', 75)).toBe('/projects/p1/board/cards/75');
  });
});

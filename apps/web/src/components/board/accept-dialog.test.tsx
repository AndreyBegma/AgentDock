import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { UnlandedBanner } from './accept-dialog';

describe('Accept dialog, work not in the base (#709)', () => {
  test('names the missing landing and what confirming means', () => {
    const html = renderToStaticMarkup(
      <UnlandedBanner reason="C-7’s pull request #77 into develop has not merged, so its work is not in develop yet" />,
    );
    expect(html).toContain('Its work is not in the base');
    expect(html).toContain('#77 into develop has not merged');
    expect(html).toContain(
      'Accept anyway only if this work is not meant to land',
    );
  });
});

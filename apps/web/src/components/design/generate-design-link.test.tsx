import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { stackDesignHref } from '../../lib/design/href';
import { GenerateDesignLink } from './generate-design-link';

describe('GenerateDesignLink', () => {
  test('opens the stack design viewer instead of generating', () => {
    const href = stackDesignHref('p1', 3);
    const html = renderToStaticMarkup(<GenerateDesignLink href={href} />);
    expect(html).toContain('Generate design');
    expect(html).toContain(`href="${href}"`);
    expect(html).not.toContain('<button');
  });
});

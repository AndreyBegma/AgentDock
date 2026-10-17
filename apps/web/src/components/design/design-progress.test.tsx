import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { STARTING } from '../../lib/design/progress';
import { DesignStarting } from './design-progress';

describe('DesignStarting (#606)', () => {
  test('says the design is starting and offers Stop to an operator', () => {
    const html = renderToStaticMarkup(
      <DesignStarting canStop stopping={false} onStop={() => {}} />,
    );
    expect(html).toContain(STARTING);
    expect(html).toContain('role="status"');
    expect(html).toContain('>Stop<');
  });

  test('offers no Stop to a viewer', () => {
    const html = renderToStaticMarkup(
      <DesignStarting canStop={false} stopping={false} onStop={() => {}} />,
    );
    expect(html).not.toContain('Stop');
  });
});

import { describe, expect, test } from 'bun:test';
import { APP_VERSION } from '@nautelle/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { versionLabel } from '../../../lib/whats-new/whats-new';
import AboutPage from './page';

describe('the About page (C-293, C-294)', () => {
  test('shows the product version from the shared changelog', () => {
    const html = renderToStaticMarkup(<AboutPage />);
    expect(html).toContain(versionLabel(APP_VERSION));
  });
});

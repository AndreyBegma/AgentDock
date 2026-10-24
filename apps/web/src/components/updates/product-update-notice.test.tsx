import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { UPGRADE_GUIDE_URL } from '../../lib/updates/product-update';
import { ProductUpdateNotice } from './product-update-notice';

const release = {
  version: '0.16.0',
  url: 'https://github.com/AndreyBegma/Nautelle/releases/tag/v0.16.0',
};

describe('ProductUpdateNotice (C-374)', () => {
  test('names the release and links its notes and the upgrade guide', () => {
    const html = renderToStaticMarkup(
      <ProductUpdateNotice release={release} onDismiss={() => {}} />,
    );
    expect(html).toContain('Nautelle 0.16.0 is available —');
    expect(html).toContain(`href="${release.url}"`);
    expect(html).toContain('release notes');
    expect(html).toContain(`href="${UPGRADE_GUIDE_URL}"`);
  });

  test('the dismissal is the caller’s', () => {
    let dismissed = 0;
    const banner = ProductUpdateNotice({
      release,
      onDismiss: () => {
        dismissed += 1;
      },
    });
    (banner.props as { onDismiss: () => void }).onDismiss();
    expect(dismissed).toBe(1);
  });
});

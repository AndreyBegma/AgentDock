import { describe, expect, test } from 'bun:test';
import { DEFAULT_VIEWPORTS } from '@nautelle/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { design, revision } from '../../lib/design/fixtures';
import { resolveViewerState } from '../../lib/design/viewer-state';
import { ViewerToolbar } from './viewer-toolbar';

const render = () => {
  const d = design({ revisions: [revision()] });
  const state = resolveViewerState(
    new URLSearchParams(),
    d.revisions,
    DEFAULT_VIEWPORTS,
  );
  return renderToStaticMarkup(
    <ViewerToolbar
      state={state}
      variants={[1, 2]}
      revisions={d.revisions}
      onChange={() => {}}
    />,
  );
};

describe('ViewerToolbar', () => {
  test('theme, variant and revision stay', () => {
    const html = render();
    expect(html).toContain('aria-label="Theme"');
    expect(html).toContain('aria-label="Variant"');
    expect(html).toContain('aria-label="Revision"');
  });

  // #886: every device is on the canvas, which has its own zoom.
  test('no Mobile/Desktop switch, typed width or zoom', () => {
    const html = render();
    expect(html).not.toContain('aria-label="Viewport"');
    expect(html).not.toContain('Width in pixels');
    expect(html).not.toContain('Zoom');
  });
});

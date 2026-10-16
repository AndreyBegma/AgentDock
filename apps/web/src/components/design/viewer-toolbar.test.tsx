import { describe, expect, test } from 'bun:test';
import { DEFAULT_VIEWPORTS } from '@agentdock/shared';
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
      zoom={1}
      viewports={DEFAULT_VIEWPORTS}
      variants={[1, 2]}
      revisions={d.revisions}
      pinMode={false}
      canPin
      onChange={() => {}}
      onPinMode={() => {}}
    />,
  );
};

describe('ViewerToolbar', () => {
  // #399: Pin wrapped alone onto a second row. The controls are grouped so a
  // narrow row wraps a group, and Pin always travels with the theme/revision.
  test('Pin sits in the same wrap group as Theme, not loose in the row', () => {
    const html = render();
    const review = html.split('data-toolbar-group="review"')[1] ?? '';
    expect(review).toContain('aria-label="Theme"');
    expect(review).toContain('Pin');
  });

  test('viewport and zoom each form their own group', () => {
    const html = render();
    expect(html).toContain('data-toolbar-group="view"');
    expect(html).toContain('data-toolbar-group="zoom"');
  });
});

import { describe, expect, test } from 'bun:test';
import { DEFAULT_VIEWPORTS, type TaskDesignView } from '@nautelle/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { comment, design, framesOf, revision } from '../../lib/design/fixtures';
import { devicesOf, resolveViewerState } from '../../lib/design/viewer-state';
import { commentFocus, DesignViewer } from './design-viewer';

const ignore = async () => {};
const actions = {
  patch: ignore,
  generate: ignore,
  comment: ignore,
  revise: ignore,
  approve: ignore,
  complete: ignore,
  stop: ignore,
};

const render = (d: TaskDesignView, query = '') =>
  renderToStaticMarkup(
    <DesignViewer
      projectId="p1"
      design={d}
      state={resolveViewerState(
        new URLSearchParams(query),
        d.revisions,
        devicesOf(d),
      )}
      canOperate
      busy={null}
      actions={actions}
      onChange={() => {}}
    />,
  );

const framed = (devices: TaskDesignView['devices'] = null) =>
  design({
    devices,
    revisions: [
      revision({
        frames: framesOf('rev-1-1', ['Screen', 'Breakdown', 'States']),
      }),
    ],
  });

describe('DesignViewer (#886)', () => {
  test('one tab per frame; the tab in view draws the frame once per device', () => {
    const html = render(framed(), 'frame=1');
    expect(html.match(/role="tab"/g)).toHaveLength(3);
    expect(html).toContain('aria-label="Breakdown on every device"');
    for (const d of DEFAULT_VIEWPORTS) {
      expect(html).toContain(`aria-label="${d.name} · ${d.width}×${d.height}"`);
    }
    expect(html.match(/frames\/1\/html/g)).toHaveLength(
      DEFAULT_VIEWPORTS.length,
    );
    expect(html).not.toContain('frames/0/html');
    expect(html).toContain('Fit all');
    expect(html).toContain('100%');
  });

  test('the devices stored on the design are the ones drawn', () => {
    const html = render(
      framed([
        { name: 'Wide', width: 1920, height: 1080 },
        { name: 'Watch', width: 200, height: 240 },
      ]),
    );
    expect(html).toContain('aria-label="Wide · 1920×1080"');
    expect(html).toContain('aria-label="Watch · 200×240"');
    expect(html).not.toContain('aria-label="Tablet');
  });

  test('no Mobile/Desktop switch or typed width; Move and Comment tools', () => {
    const html = render(framed());
    expect(html).not.toContain('aria-label="Viewport"');
    expect(html).not.toContain('Width in pixels');
    expect(html).toContain('aria-label="Move (V)"');
    expect(html).toContain('aria-label="Comment (C)"');
  });

  test('a link reopens the same zoom and pan', () => {
    const html = render(framed(), 'zoom=0.5&pan=120,-40');
    expect(html).toContain('translate(120px, -40px) scale(0.5)');
  });

  test('an earlier revision with a mobile frame and no stored devices: project presets, Mobile a tab', () => {
    const presets = [
      { name: 'Laptop', width: 1280, height: 800 },
      { name: 'Pocket', width: 375, height: 667 },
    ];
    const html = render(
      design({
        devices: null,
        viewports: presets,
        revisions: [
          revision({ frames: framesOf('rev-1-1', ['Mockup', 'Mobile']) }),
        ],
      }),
    );
    expect(html.match(/role="tab"/g)).toHaveLength(2);
    expect(html).toContain('Mobile');
    expect(html).toContain('aria-label="Laptop · 1280×800"');
    expect(html).toContain('aria-label="Pocket · 375×667"');
  });

  test('a comment is a button that opens where it was left', () => {
    const d = framed();
    const html = render({
      ...d,
      comments: [comment({ kind: 'pin', viewport: 'Tablet', theme: 'light' })],
    });
    expect(html).toContain('title="Show where it was left"');
    expect(html).toContain('Pin 1 · Tablet · light');
  });
});

describe('commentFocus (#886)', () => {
  const devices = DEFAULT_VIEWPORTS;
  const [desktop, tablet] = DEFAULT_VIEWPORTS;
  if (!desktop || !tablet) throw new Error('the default devices are missing');

  test('a pin centres on its point on the device it names', () => {
    expect(
      commentFocus(
        comment({ kind: 'pin', viewport: 'Tablet', x: 100, y: 200 }),
        devices,
        desktop,
      ),
    ).toEqual({ frameId: 'Tablet', point: { x: 100, y: 200 } });
  });

  test('a pin below the fold is held to the device', () => {
    expect(
      commentFocus(
        comment({ kind: 'pin', viewport: 'Tablet', x: 100, y: 5000 }),
        devices,
        desktop,
      ).point,
    ).toEqual({ x: 100, y: tablet.height });
  });

  test('a screen comment centres its device; an unknown or no device, the one in view', () => {
    expect(
      commentFocus(
        comment({ kind: 'screen', viewport: 'Tablet' }),
        devices,
        desktop,
      ),
    ).toEqual({
      frameId: 'Tablet',
      point: { x: tablet.width / 2, y: tablet.height / 2 },
    });
    expect(
      commentFocus(
        comment({ kind: 'pin', viewport: 'Mobile', x: 10, y: 10 }),
        devices,
        desktop,
      ),
    ).toEqual({
      frameId: desktop.name,
      point: { x: desktop.width / 2, y: desktop.height / 2 },
    });
    expect(commentFocus(comment(), devices, desktop).frameId).toBe(
      desktop.name,
    );
  });
});

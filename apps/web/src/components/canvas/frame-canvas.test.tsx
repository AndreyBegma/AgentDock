import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Zoom } from '../../lib/design/zoom';
import { type CanvasFrame, FrameCanvas, useFrameCanvas } from './frame-canvas';

function Scale() {
  return <span data-scale={useFrameCanvas().scale} />;
}

const frames: CanvasFrame[] = [
  { id: 'desktop', name: 'Desktop', width: 1440, height: 900, content: null },
  {
    id: 'phone',
    name: 'Phone',
    width: 390,
    height: 844,
    active: true,
    content: <Scale />,
  },
];

const render = (zoom: Zoom, pan = { x: 12, y: 34 }) =>
  renderToStaticMarkup(
    <FrameCanvas
      frames={frames}
      zoom={zoom}
      onZoomChange={() => {}}
      pan={pan}
      onPanChange={() => {}}
    />,
  );

describe('FrameCanvas (#866)', () => {
  test('lays the frames out side by side at their own sizes, labelled', () => {
    const html = render(0.5);
    expect(html).toContain('aria-label="Desktop · 1440×900"');
    expect(html).toContain('aria-label="Phone · 390×844"');
    expect(html).toContain('left:0;top:0;width:1440px;height:900px');
    expect(html).toContain('left:1520px;top:0;width:390px;height:844px');
    expect(html).toContain('>Phone</span>');
    expect(html).toContain('>· 390×844</span>');
  });

  test('draws the world at the controlled zoom and pan', () => {
    const html = render(0.5);
    expect(html).toContain('transform:translate(12px, 34px) scale(0.5)');
    // Labels are drawn at 1 / scale, so they keep their size on screen.
    expect(html).toContain('transform:scale(2)');
    expect(html).toContain('>50 %</output>');
  });

  test('clamps a zoom from outside the range', () => {
    expect(render(9)).toContain('scale(2)');
    expect(render(0.01)).toContain('>25 %</output>');
  });

  test('exposes the scale to the frames’ content', () => {
    expect(render(0.75)).toContain('data-scale="0.75"');
  });

  test('has the zoom controls; Fit all and 100% mark the one in effect', () => {
    const fit = render('fit');
    for (const name of ['Zoom out', 'Zoom in', 'Zoom level']) {
      expect(fit).toContain(`aria-label="${name}"`);
    }
    expect(fit).toMatch(/aria-pressed="true"[^>]*>.*Fit all/);
    // Unmeasured on the server: hidden until Fit all knows the stage.
    expect(fit).toContain('visibility:hidden');
    expect(render(1)).toMatch(/aria-pressed="true"[^>]*>100%/);
  });

  test('useFrameCanvas outside a canvas is a mistake', () => {
    expect(() => renderToStaticMarkup(<Scale />)).toThrow(
      'useFrameCanvas is used outside a FrameCanvas',
    );
  });
});

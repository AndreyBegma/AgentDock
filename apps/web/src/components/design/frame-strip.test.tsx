import { describe, expect, test } from 'bun:test';
import { TabGroup } from '@andrewbehma/glass-ui/tabs';
import { renderToStaticMarkup } from 'react-dom/server';
import { framesOf } from '../../lib/design/fixtures';
import { FrameStrip, frameKey } from './frame-strip';

const render = (names: string[], frame = 0) =>
  renderToStaticMarkup(
    <TabGroup value={String(frame)} onValueChange={() => {}}>
      <FrameStrip
        frames={framesOf('r', names)}
        frame={frame}
        variant={2}
        comments={new Map([[1, 3]])}
        pinned={new Set([1])}
        onFrame={() => {}}
      />
    </TabGroup>,
  );

describe('FrameStrip (#441)', () => {
  test('a tab per frame with its position and name; the selected one is named below', () => {
    const html = render(['Board page', 'Card page', 'Frame tabs'], 1);
    expect(html.match(/role="tab"/g)).toHaveLength(3);
    expect(html).toContain('Board page');
    expect(html).toContain('Frames · 3');
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain('design/2/card-page.html');
    expect(html).toContain('Frame 2 of 3');
    expect(html).toContain('aria-label="3 open comments"');
    expect(html).toContain('aria-label="Open pins"');
  });

  test('a revision stored before frames shows its one frame, Mockup', () => {
    const html = render(['Mockup']);
    expect(html.match(/role="tab"/g)).toHaveLength(1);
    expect(html).toContain('Mockup');
    expect(html).toContain('Frame 1 of 1');
  });

  test('#833: typed tabs show the kind label and the template is named once; legacy frames show neither', () => {
    const typed = framesOf('r', ['Overview', 'Zones']).map((f, i) => ({
      ...f,
      kind: i === 0 ? ('screen' as const) : ('breakdown' as const),
    }));
    const html = renderToStaticMarkup(
      <TabGroup value="0" onValueChange={() => {}}>
        <FrameStrip
          frames={typed}
          frame={0}
          variant={1}
          comments={new Map()}
          pinned={new Set()}
          onFrame={() => {}}
          templateName="Page"
          compare={{ on: true, onToggle: () => {} }}
        />
      </TabGroup>,
    );
    expect(html).toContain('Template ·');
    expect(html).toContain('Breakdown');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('Compare');
    const legacy = render(['Mockup']);
    expect(legacy).not.toContain('Template ·');
    expect(legacy).not.toContain('Compare');
  });

  test('[ and ] step through the frames, wrapping; one frame takes no step', () => {
    expect(frameKey({ key: ']' }, 0, 3)).toBe(1);
    expect(frameKey({ key: ']' }, 2, 3)).toBe(0);
    expect(frameKey({ key: '[' }, 0, 3)).toBe(2);
    expect(frameKey({ key: '[' }, 0, 1)).toBeNull();
    expect(frameKey({ key: 'a' }, 0, 3)).toBeNull();
  });
});

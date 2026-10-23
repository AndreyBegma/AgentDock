import { describe, expect, test } from 'bun:test';
import { TabGroup } from '@andrewbehma/glass-ui/tabs';
import { renderToStaticMarkup } from 'react-dom/server';
import { framesOf } from '../../lib/design/fixtures';
import { FrameTabs, frameKey } from './frame-tabs';

const render = (names: string[], frame = 0) =>
  renderToStaticMarkup(
    <TabGroup value={String(frame)} onValueChange={() => {}}>
      <FrameTabs
        frames={framesOf('r', names)}
        frame={frame}
        variant={2}
        comments={new Map([[1, 3]])}
        pinned={new Set([1])}
        onFrame={() => {}}
        tools={<span>theme-tools</span>}
      />
    </TabGroup>,
  );

describe('FrameTabs (#886)', () => {
  test('a tab per frame named by the frame; the selected one is named below', () => {
    const html = render(['Board page', 'Card page', 'Frame tabs'], 1);
    expect(html.match(/role="tab"/g)).toHaveLength(3);
    expect(html).toContain('aria-label="Frames"');
    expect(html).toContain('Board page');
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain('design/2/card-page.html');
    expect(html).toContain('Frame 2 of 3');
    expect(html).toContain('aria-label="3 open comments"');
    expect(html).toContain('aria-label="Open pins"');
    expect(html).toContain('theme-tools');
  });

  test('a revision stored before frames shows its one frame, Mockup', () => {
    const html = render(['Mockup']);
    expect(html.match(/role="tab"/g)).toHaveLength(1);
    expect(html).toContain('Mockup');
    expect(html).toContain('Frame 1 of 1');
  });

  test('a legacy mobile frame is just another tab', () => {
    const html = render(['Mockup', 'Mobile']);
    expect(html.match(/role="tab"/g)).toHaveLength(2);
    expect(html).toContain('Mobile');
  });

  test('#833: a kind the name does not say is shown beside it; the template is named once', () => {
    const typed = framesOf('r', ['Screen', 'Zones']).map((f, i) => ({
      ...f,
      kind: i === 0 ? ('screen' as const) : ('breakdown' as const),
    }));
    const html = renderToStaticMarkup(
      <TabGroup value="0" onValueChange={() => {}}>
        <FrameTabs
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
    expect(html.match(/>Screen</g)).toHaveLength(1);
    expect(html).toContain('Breakdown');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('Compare');
    const legacy = render(['Mockup']);
    expect(legacy).not.toContain('Template ·');
    expect(legacy).not.toContain('Compare');
  });

  test('[ and ] step through the tabs, wrapping; one tab takes no step', () => {
    expect(frameKey({ key: ']' }, 0, 3)).toBe(1);
    expect(frameKey({ key: ']' }, 2, 3)).toBe(0);
    expect(frameKey({ key: '[' }, 0, 3)).toBe(2);
    expect(frameKey({ key: '[' }, 0, 1)).toBeNull();
    expect(frameKey({ key: 'a' }, 0, 3)).toBeNull();
  });
});

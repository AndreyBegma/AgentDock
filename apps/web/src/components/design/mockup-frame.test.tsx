import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { frameEscaped, frameLoaded } from '../../lib/design/frame-messages';
import { MOCKUP_ESCAPED_NOTICE, MockupFrameShell } from './mockup-frame';

const SRC = '/api/design/1.html';

/** What `MockupFrame` renders after the loads its iframe has reported. */
const afterLoads = (count: number) => {
  let state = { src: SRC, loads: 0 };
  for (let i = 0; i < count; i++) state = frameLoaded(state, SRC);
  return renderToStaticMarkup(
    <MockupFrameShell
      escaped={frameEscaped(state, SRC)}
      src={SRC}
      title="Mockup"
    />,
  );
};

describe('MockupFrame (C-130)', () => {
  test('one load is the mockup itself: a sandboxed iframe', () => {
    const html = afterLoads(1);
    expect(html).toContain('<iframe');
    expect(html).toContain('sandbox="allow-scripts"');
    expect(html).not.toContain(MOCKUP_ESCAPED_NOTICE);
  });

  test('a second load blanks the frame and says why', () => {
    const html = afterLoads(2);
    expect(html).not.toContain('<iframe');
    expect(html).toContain('The mockup tried to leave this page');
  });
});

import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadLunaPlayer, NativeVideoPlayer, VideoPlayer } from './video-player';

const SRC = '/api/projects/p1/attachments/a1/content';

describe('VideoPlayer adapter (C-371)', () => {
  test('plays with a native <video> that streams the attachment', () => {
    const html = renderToStaticMarkup(<VideoPlayer src={SRC} title="Demo" />);
    expect(html).toContain('<video');
    expect(html).toContain(`src="${SRC}"`);
    expect(html).toContain('controls');
    expect(html).toContain('preload="metadata"');
  });

  test('keeps the native player when Luna fails to load', () => {
    const html = renderToStaticMarkup(
      <VideoPlayer
        src={SRC}
        title="Demo"
        loadLuna={() => Promise.reject(new Error('chunk failed'))}
      />,
    );
    expect(html).toBe(
      renderToStaticMarkup(<NativeVideoPlayer src={SRC} title="Demo" />),
    );
  });

  test('luna-player is not installable yet, so its loader rejects', async () => {
    await expect(loadLunaPlayer()).rejects.toThrow('not installed');
  });
});

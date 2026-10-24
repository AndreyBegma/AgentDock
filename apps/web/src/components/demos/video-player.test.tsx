import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  type LunaPlayerProps,
  loadLunaPlayer,
  NativeVideoPlayer,
  PlayerSwitch,
  VideoPlayer,
} from './video-player';

const SRC = '/api/projects/p1/attachments/a1/content';

const captured: LunaPlayerProps[] = [];
function FakeLuna(props: LunaPlayerProps) {
  captured.push(props);
  return <div data-luna={props.src} />;
}

const native = renderToStaticMarkup(
  <NativeVideoPlayer src={SRC} title="Demo" />,
);

describe('VideoPlayer adapter (C-371, C-382)', () => {
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
    expect(html).toBe(native);
  });

  test('loadLunaPlayer imports luna-player/player and renders it', async () => {
    const Luna = await loadLunaPlayer();
    const html = renderToStaticMarkup(<Luna src={SRC} title="Demo" />);
    // Luna attaches `src` to its <video> after mount, so the server markup
    // shows its frame: the 16:9 box and the title on the play button.
    expect(html).toContain('aspect-ratio:16/9');
    expect(html).toContain('aria-label="Demo"');
  });
});

describe('PlayerSwitch', () => {
  test('uses Luna when it is loaded', () => {
    captured.length = 0;
    const html = renderToStaticMarkup(
      <PlayerSwitch
        Luna={FakeLuna}
        failedSrc={null}
        onFail={() => {}}
        src={SRC}
        title="Demo"
      />,
    );
    expect(html).toBe(`<div data-luna="${SRC}"></div>`);
    expect(captured[0]?.title).toBe('Demo');
  });

  test('uses the native element while Luna is not loaded', () => {
    const html = renderToStaticMarkup(
      <PlayerSwitch
        Luna={null}
        failedSrc={null}
        onFail={() => {}}
        src={SRC}
        title="Demo"
      />,
    );
    expect(html).toBe(native);
  });

  test('onError reports the source, and a failed source goes native', () => {
    captured.length = 0;
    const failed: string[] = [];
    renderToStaticMarkup(
      <PlayerSwitch
        Luna={FakeLuna}
        failedSrc={null}
        onFail={(src) => failed.push(src)}
        src={SRC}
        title="Demo"
      />,
    );
    captured[0]?.onError?.();
    expect(failed).toEqual([SRC]);

    const html = renderToStaticMarkup(
      <PlayerSwitch
        Luna={FakeLuna}
        failedSrc={SRC}
        onFail={() => {}}
        src={SRC}
        title="Demo"
      />,
    );
    expect(html).toBe(native);
  });

  test('a new source gets Luna again after an earlier failure', () => {
    const html = renderToStaticMarkup(
      <PlayerSwitch
        Luna={FakeLuna}
        failedSrc="/other"
        onFail={() => {}}
        src={SRC}
        title="Demo"
      />,
    );
    expect(html).toContain('data-luna');
  });
});

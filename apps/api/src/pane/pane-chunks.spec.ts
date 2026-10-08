import type { PaneFrame } from '@agentdock/shared/protocol';
import { chunkPaneFrame } from './pane-chunks';

const size = (frame: PaneFrame) => Buffer.byteLength(JSON.stringify(frame));

/** Applies frames in order, as the web client does. */
const apply = (frames: PaneFrame[], start: string[] = []): string[] => {
  let screen = start;
  for (const frame of frames) {
    if (frame.type === 'full') screen = [...frame.lines];
    if (frame.type === 'patch') {
      screen = [...screen.slice(0, frame.from), ...frame.lines];
    }
  }
  return screen;
};

const lines = (n: number, width: number) =>
  Array.from({ length: n }, (_, i) => `\x1b[3${i % 8}m${'#'.repeat(width)}`);

describe('chunkPaneFrame', () => {
  it('returns a frame that fits, and ended, unchanged', () => {
    const frame: PaneFrame = {
      type: 'full',
      lines: ['a'],
      cursor: { x: 1, y: 0 },
    };
    expect(chunkPaneFrame(frame, 1024)).toEqual([frame]);
    expect(chunkPaneFrame({ type: 'ended' }, 10)).toEqual([{ type: 'ended' }]);
  });

  it('splits a full into a full with the cursor and patches that rebuild it', () => {
    const original: PaneFrame = {
      type: 'full',
      lines: lines(500, 120),
      cursor: { x: 3, y: 499 },
    };
    const pieces = chunkPaneFrame(original, 8 * 1024);
    expect(pieces.length).toBeGreaterThan(5);
    expect(pieces[0]).toMatchObject({ type: 'full', cursor: { x: 3, y: 499 } });
    expect(pieces.slice(1).every((p) => p.type === 'patch')).toBe(true);
    expect(pieces.every((p) => size(p) <= 8 * 1024)).toBe(true);
    expect(apply(pieces)).toEqual(original.lines);
  });

  it('splits a patch into consecutive patches from its own offset', () => {
    const before = lines(40, 10);
    const original: PaneFrame = {
      type: 'patch',
      from: 30,
      lines: lines(300, 60),
    };
    const pieces = chunkPaneFrame(original, 4 * 1024);
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces[0]).toMatchObject({ type: 'patch', from: 30 });
    expect(pieces.every((p) => size(p) <= 4 * 1024)).toBe(true);
    expect(apply(pieces, before)).toEqual(apply([original], before));
  });

  it('truncates only a line that cannot fit on its own', () => {
    const huge = `\x1b[0m${'é'.repeat(5000)}`;
    const original: PaneFrame = {
      type: 'full',
      lines: ['before', huge, 'after'],
      cursor: { x: 0, y: 0 },
    };
    const pieces = chunkPaneFrame(original, 2048);
    expect(pieces.every((p) => size(p) <= 2048)).toBe(true);
    const screen = apply(pieces);
    expect(screen).toHaveLength(3);
    expect(screen[0]).toBe('before');
    expect(screen[2]).toBe('after');
    expect(huge.startsWith(screen[1])).toBe(true);
    expect(screen[1].length).toBeGreaterThan(500);
  });
});

import { describe, expect, it } from 'bun:test';
import {
  MODEL_IMAGE_MAX_BYTES,
  MODEL_IMAGE_MAX_EDGE,
  MODEL_IMAGE_MAX_PIXELS,
  modelImage,
  modelImageSize,
} from './model-image';

/** A real image of `width` × `height` in `format`, made from a 1×1 PNG. */
const PIXEL = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  ),
  (c) => c.charCodeAt(0),
);
const image = (
  width: number,
  height: number,
  format: 'png' | 'jpeg' | 'webp',
): Promise<Uint8Array> => {
  const img = new Bun.Image(PIXEL).resize(width, height);
  if (format === 'png') img.png();
  else if (format === 'jpeg') img.jpeg({ quality: 100 });
  else img.webp({ quality: 100 });
  return img.bytes();
};

const metadata = (bytes: Uint8Array) => new Bun.Image(bytes).metadata();

describe('modelImageSize (#628)', () => {
  it('keeps a size within the edge and the pixel limit', () => {
    expect(modelImageSize(1000, 800)).toEqual({ width: 1000, height: 800 });
  });

  it('scales the longest edge to 1568 px, keeping the aspect ratio', () => {
    expect(modelImageSize(3136, 400)).toEqual({ width: 1568, height: 200 });
  });

  it('scales a square to 1.15 megapixels even under the edge', () => {
    const { width, height } = modelImageSize(1500, 1500);
    expect(width).toBe(height);
    expect(width * height).toBeLessThanOrEqual(MODEL_IMAGE_MAX_PIXELS);
    expect(width).toBeGreaterThan(1060);
  });
});

describe('modelImage (#628)', () => {
  it.each([
    'png',
    'jpeg',
    'webp',
  ] as const)('scales a large %s down in its own format', async (format) => {
    const source = await image(4000, 1000, format);
    const out = await modelImage(source, `image/${format}`);
    const meta = await metadata(out);
    expect(meta.format).toBe(format);
    expect(meta.width).toBe(MODEL_IMAGE_MAX_EDGE);
    expect(meta.height).toBe(MODEL_IMAGE_MAX_EDGE / 4);
    expect(meta.width * meta.height).toBeLessThanOrEqual(
      MODEL_IMAGE_MAX_PIXELS,
    );
    expect(out.byteLength).toBeLessThanOrEqual(source.byteLength);
    expect(out.byteLength).toBeLessThanOrEqual(MODEL_IMAGE_MAX_BYTES);
  });

  it('leaves an image that already fits as it is', async () => {
    const source = await image(800, 600, 'png');
    expect(await modelImage(source, 'image/png')).toBe(source);
  });

  it('leaves a GIF, a text file and bytes that do not decode as they are', async () => {
    const gif = new TextEncoder().encode('GIF89a not really');
    expect(await modelImage(gif, 'image/gif')).toBe(gif);
    const notes = new TextEncoder().encode('notes');
    expect(await modelImage(notes, 'text/plain')).toBe(notes);
    const broken = new TextEncoder().encode('not a png');
    expect(await modelImage(broken, 'image/png')).toBe(broken);
  });
});

/**
 * #628: an attached image as a model reads it. Claude scales every image
 * down to about 1568 px on its longest edge and 1.15 megapixels before it
 * counts its tokens, so a larger one costs upload and context for nothing.
 * The runner scales it to that size itself — the format and the file name
 * stay, so the type the name implies is still the type of the bytes — and
 * re-encodes harder when it is still over `MODEL_IMAGE_MAX_BYTES`.
 */

/** The longest edge, in pixels, an image a turn reads keeps. */
export const MODEL_IMAGE_MAX_EDGE = 1568;

/** The pixels (width × height) an image a turn reads keeps at most. */
export const MODEL_IMAGE_MAX_PIXELS = 1_150_000;

/** Over this many bytes after scaling, an image is re-encoded more compactly. */
export const MODEL_IMAGE_MAX_BYTES = 1024 * 1024;

type Encodable = 'png' | 'jpeg' | 'webp';

/** GIF has no encoder: it is left as it is, like every other type. */
const ENCODABLE: Readonly<Record<string, Encodable>> = {
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/webp': 'webp',
};

/** The size `width` × `height` scales to; the same size when it fits. */
export const modelImageSize = (
  width: number,
  height: number,
): { width: number; height: number } => {
  const scale = Math.min(
    1,
    MODEL_IMAGE_MAX_EDGE / Math.max(width, height),
    Math.sqrt(MODEL_IMAGE_MAX_PIXELS / (width * height)),
  );
  if (scale >= 1) return { width, height };
  return {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
  };
};

const encode = (
  bytes: Uint8Array,
  format: Encodable,
  size: { width: number; height: number } | null,
  compact: boolean,
): Promise<Uint8Array> => {
  const image = new Bun.Image(bytes);
  if (size) image.resize(size.width, size.height, { fit: 'fill' });
  if (format === 'png') {
    image.png(
      compact
        ? { compressionLevel: 9, palette: true }
        : { compressionLevel: 9 },
    );
  } else if (format === 'jpeg') {
    image.jpeg({ quality: compact ? 70 : 85 });
  } else {
    image.webp({ quality: compact ? 70 : 85 });
  }
  return image.bytes();
};

/**
 * `bytes` as a turn should read them: a PNG, JPEG or WebP over the edge,
 * pixel or byte limit scaled down and re-encoded in its own format; anything
 * else, or an image that fails to decode, unchanged. Never larger than the
 * source.
 */
export const modelImage = async (
  bytes: Uint8Array,
  mime: string,
): Promise<Uint8Array> => {
  const format = ENCODABLE[mime];
  if (!format) return bytes;
  try {
    const { width, height } = await new Bun.Image(bytes).metadata();
    const target = modelImageSize(width, height);
    const resize =
      target.width !== width || target.height !== height ? target : null;
    if (!resize && bytes.byteLength <= MODEL_IMAGE_MAX_BYTES) return bytes;
    let out = await encode(bytes, format, resize, false);
    if (out.byteLength > MODEL_IMAGE_MAX_BYTES) {
      out = await encode(bytes, format, resize, true);
    }
    return out.byteLength < bytes.byteLength ? out : bytes;
  } catch {
    // The model reads the original rather than nothing.
    return bytes;
  }
};

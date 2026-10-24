/** An inclusive byte range of a stored file (RFC 9110 §14.1.2). */
export interface ByteRange {
  start: number;
  end: number;
}

/** No single range of the file can be served: 416, the size in `Content-Range`. */
export const UNSATISFIABLE = 'unsatisfiable' as const;

/**
 * ADR-0089: the one byte range a `Range` header asks of a file of `size`
 * bytes, so a video player can seek. `null` serves the whole file with 200 —
 * no header, another unit, several ranges or a header that does not parse
 * (RFC 9110 lets a server ignore those). `unsatisfiable` is a well-formed
 * range that starts past the end, or a suffix of zero bytes.
 */
export const parseByteRange = (
  header: string | undefined,
  size: number,
): ByteRange | typeof UNSATISFIABLE | null => {
  if (header === undefined) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, from, to] = match;
  if (from === '' && to === '') return null;
  if (from === '') {
    // `bytes=-n`: the last n bytes.
    const suffix = Number(to);
    if (suffix === 0 || size === 0) return UNSATISFIABLE;
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(from);
  if (to !== '' && Number(to) < start) return null;
  if (start >= size) return UNSATISFIABLE;
  const end = to === '' ? size - 1 : Math.min(Number(to), size - 1);
  return { start, end };
};

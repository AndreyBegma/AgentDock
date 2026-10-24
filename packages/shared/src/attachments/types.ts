/**
 * The upload allowlist (issue #309 D5, ADR-0031 §5). The type is decided by
 * the content signature — never by the name or the browser's MIME type. Only
 * a file with no binary signature looks at its extension, and then only to
 * accept it as text.
 */

export const ATTACHMENT_IMAGE_MIMES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
] as const;

export const ATTACHMENT_TEXT_MIMES = [
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
  'text/x-diff',
] as const;

/**
 * ADR-0089 (amends ADR-0031 §5): demo videos, recorded by DemoFlow on the
 * runner. Each has its own size limit (`attachmentMaxBytes`) and does not
 * count toward `ATTACHMENTS_PER_CARD_MAX`.
 */
export const ATTACHMENT_VIDEO_MIMES = ['video/mp4', 'video/webm'] as const;
export type AttachmentVideoMime = (typeof ATTACHMENT_VIDEO_MIMES)[number];

/** Every MIME type an attachment can be stored with: the detected one. */
export const ATTACHMENT_MIMES = [
  ...ATTACHMENT_IMAGE_MIMES,
  'application/pdf',
  ...ATTACHMENT_TEXT_MIMES,
  ...ATTACHMENT_VIDEO_MIMES,
] as const;
export type AttachmentMime = (typeof ATTACHMENT_MIMES)[number];

/** D5: the extensions a signature-less UTF-8 file is accepted under, and its MIME. */
export const ATTACHMENT_TEXT_EXTENSIONS: Readonly<
  Record<string, AttachmentMime>
> = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.log': 'text/plain',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.diff': 'text/x-diff',
  '.patch': 'text/x-diff',
};

const MIMES: ReadonlySet<string> = new Set(ATTACHMENT_MIMES);

export const isAttachmentMime = (value: string): value is AttachmentMime =>
  MIMES.has(value);

const VIDEO_MIMES: ReadonlySet<string> = new Set(ATTACHMENT_VIDEO_MIMES);

/** ADR-0089: a demo video type — its own size limit, outside the per-card count. */
export const isAttachmentVideo = (
  value: string,
): value is AttachmentVideoMime => VIDEO_MIMES.has(value);

const ascii = (text: string): number[] =>
  [...text].map((ch) => ch.charCodeAt(0));

/** `bytes` holds `expected` at `offset`; `null` in `expected` matches any byte. */
const startsWith = (
  bytes: Uint8Array,
  expected: readonly (number | null)[],
  offset = 0,
): boolean =>
  bytes.length >= offset + expected.length &&
  expected.every((b, i) => b === null || bytes[offset + i] === b);

/** `bytes` holds the ASCII `needle` somewhere in its first `within` bytes. */
const contains = (
  bytes: Uint8Array,
  needle: string,
  within: number,
): boolean => {
  const expected = ascii(needle);
  const end = Math.min(bytes.length, within) - expected.length;
  for (let at = 0; at <= end; at++) {
    if (startsWith(bytes, expected, at)) return true;
  }
  return false;
};

/**
 * ADR-0089: the ISO base media major brands of an MP4 a browser plays. A
 * brand list, not just `ftyp`, so HEIC, AVIF and QuickTime files — `ftyp`
 * too — stay refused.
 */
const MP4_BRANDS: readonly string[] = [
  'isom',
  'iso2',
  'iso3',
  'iso4',
  'iso5',
  'iso6',
  'mp41',
  'mp42',
  'avc1',
  'dash',
  'M4V ',
];

const SIGNATURES: readonly {
  mime: AttachmentMime;
  matches: (bytes: Uint8Array) => boolean;
}[] = [
  {
    mime: 'image/png',
    matches: (b) =>
      startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  },
  { mime: 'image/jpeg', matches: (b) => startsWith(b, [0xff, 0xd8, 0xff]) },
  {
    mime: 'image/gif',
    matches: (b) =>
      startsWith(b, ascii('GIF87a')) || startsWith(b, ascii('GIF89a')),
  },
  {
    mime: 'image/webp',
    matches: (b) =>
      startsWith(b, ascii('RIFF')) && startsWith(b, ascii('WEBP'), 8),
  },
  { mime: 'application/pdf', matches: (b) => startsWith(b, ascii('%PDF-')) },
  {
    mime: 'video/mp4',
    matches: (b) =>
      startsWith(b, ascii('ftyp'), 4) &&
      MP4_BRANDS.some((brand) => startsWith(b, ascii(brand), 8)),
  },
  {
    // EBML magic, then the `webm` DocType within the EBML header.
    mime: 'video/webm',
    matches: (b) =>
      startsWith(b, [0x1a, 0x45, 0xdf, 0xa3]) &&
      contains(b, 'webm', ATTACHMENT_SIGNATURE_BYTES),
  },
];

/** The longest prefix a binary signature reads (the WebM header's DocType). */
export const ATTACHMENT_SIGNATURE_BYTES = 64;

/** The MIME type of a binary signature at the start of `head`, or `null`. */
export const attachmentSignatureMime = (
  head: Uint8Array,
): AttachmentMime | null =>
  SIGNATURES.find((s) => s.matches(head))?.mime ?? null;

/** The extension of `name`, lower case with its dot; `''` without one. */
export const attachmentExtension = (name: string): string => {
  const base = name.slice(
    Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\')) + 1,
  );
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot).toLowerCase() : '';
};

/** D5: valid UTF-8 with no NUL byte. */
export const isAttachmentText = (bytes: Uint8Array): boolean => {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
};

const mimeOf = (
  head: Uint8Array,
  name: string,
  isText: () => boolean,
): AttachmentMime | null => {
  const signed = attachmentSignatureMime(head);
  if (signed !== null) return signed;
  const text = ATTACHMENT_TEXT_EXTENSIONS[attachmentExtension(name)];
  return text !== undefined && isText() ? text : null;
};

/**
 * D5: the type an upload is stored with, from its whole content; `null` is
 * `unsupported_type`. A binary signature wins over the name (a PNG named
 * `.txt` is `image/png`); a file without one is text only when it is valid
 * UTF-8, has no NUL, and its extension is a text extension. SVG, HTML and
 * archives have neither, so they are refused.
 */
export const detectAttachmentMime = (
  bytes: Uint8Array,
  name: string,
): AttachmentMime | null => mimeOf(bytes, name, () => isAttachmentText(bytes));

/**
 * What a streamed upload was checked for, chunk by chunk (#156): its first
 * `ATTACHMENT_SIGNATURE_BYTES` and whether the whole is `isAttachmentText`.
 */
export interface AttachmentScan {
  head: Uint8Array;
  text: boolean;
}

/** `detectAttachmentMime` of a file never held whole in memory (#156). */
export const detectScannedAttachmentMime = (
  scan: AttachmentScan,
  name: string,
): AttachmentMime | null => mimeOf(scan.head, name, () => scan.text);

const INLINE: ReadonlySet<string> = new Set([
  ...ATTACHMENT_IMAGE_MIMES,
  ...ATTACHMENT_VIDEO_MIMES,
]);

/**
 * D8: raster images and (ADR-0089) demo videos are served `inline`;
 * everything else as `attachment`, with `Content-Security-Policy: sandbox`.
 */
export const attachmentDisposition = (
  mime: AttachmentMime,
): 'inline' | 'attachment' => (INLINE.has(mime) ? 'inline' : 'attachment');

/** D10: the type as the worker prompt names it. */
export const attachmentKindLabel = (mime: AttachmentMime): string =>
  isAttachmentVideo(mime)
    ? 'video'
    : INLINE.has(mime)
      ? 'image'
      : mime === 'application/pdf'
        ? 'PDF'
        : 'text';

import { describe, expect, it } from 'bun:test';
import {
  ATTACHMENT_REFUSAL,
  attachmentContentPath,
  attachmentRefSchema,
  cardAttachmentSnapshotSchema,
  runnerAttachmentPath,
} from './contracts';
import {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_NAME_MAX,
  ATTACHMENT_SAFE_NAME_MAX,
  ATTACHMENT_UPLOAD_MAX_BYTES,
  ATTACHMENT_VIDEO_MAX_BYTES,
  ATTACHMENTS_PER_CARD_MAX,
  ATTACHMENTS_PROJECT_QUOTA_DEFAULT_BYTES,
  attachmentMaxBytes,
} from './limits';
import {
  ATTACHMENT_FALLBACK_NAME,
  attachmentDisplayName,
  attachmentFileName,
  attachmentSafeName,
  attachmentWorktreePath,
} from './names';
import {
  ATTACHMENT_MIMES,
  attachmentDisposition,
  attachmentKindLabel,
  detectAttachmentMime,
  detectScannedAttachmentMime,
  isAttachmentVideo,
} from './types';

const bytesOf = (...parts: (number[] | string)[]): Uint8Array =>
  new Uint8Array(
    parts.flatMap((p) =>
      typeof p === 'string' ? [...new TextEncoder().encode(p)] : p,
    ),
  );

const PNG = bytesOf([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'IHDR');
const JPEG = bytesOf([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10], 'JFIF');
const GIF = bytesOf('GIF89a', [0x01, 0x00]);
const WEBP = bytesOf('RIFF', [0x24, 0x00, 0x00, 0x00], 'WEBPVP8 ');
const PDF = bytesOf('%PDF-1.7\n');
const ZIP = bytesOf([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);
const BINARY = bytesOf([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x00, 0x00]);
/** An ISO BMFF `ftyp` box: size, `ftyp`, the major brand, a minor version. */
const ftyp = (brand: string): Uint8Array =>
  bytesOf([0x00, 0x00, 0x00, 0x20], 'ftyp', brand, [0x00, 0x00, 0x02, 0x00]);
const MP4 = ftyp('isom');
/** EBML magic, an EBML header size, then the `webm` DocType element. */
const WEBM = bytesOf(
  [0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0x82, 0x84],
  'webm',
);

describe('limits (#309 D4)', () => {
  it('are 25 MiB a file, 20 a card, 1 GiB a project', () => {
    expect(ATTACHMENT_MAX_BYTES).toBe(26_214_400);
    expect(ATTACHMENTS_PER_CARD_MAX).toBe(20);
    expect(ATTACHMENTS_PROJECT_QUOTA_DEFAULT_BYTES).toBe(1_073_741_824);
  });

  it('ADR-0090: a video may be 100 MiB, every other type 25 MiB', () => {
    expect(ATTACHMENT_VIDEO_MAX_BYTES).toBe(104_857_600);
    expect(ATTACHMENT_UPLOAD_MAX_BYTES).toBe(ATTACHMENT_VIDEO_MAX_BYTES);
    expect(attachmentMaxBytes('video/mp4')).toBe(ATTACHMENT_VIDEO_MAX_BYTES);
    expect(attachmentMaxBytes('video/webm')).toBe(ATTACHMENT_VIDEO_MAX_BYTES);
    expect(attachmentMaxBytes('image/png')).toBe(ATTACHMENT_MAX_BYTES);
    expect(attachmentMaxBytes('application/pdf')).toBe(ATTACHMENT_MAX_BYTES);
    expect(attachmentMaxBytes('text/plain')).toBe(ATTACHMENT_MAX_BYTES);
  });

  it('each refusal has its own code', () => {
    expect(ATTACHMENT_REFUSAL).toEqual({
      tooLarge: 'too_large',
      unsupportedType: 'unsupported_type',
      tooMany: 'too_many',
      quotaExceeded: 'quota_exceeded',
      pendingExceeded: 'pending_exceeded',
      notClaimable: 'not_claimable',
    });
  });
});

describe('detectAttachmentMime — the allowlist by content (#309 D5)', () => {
  it('detects PNG, JPEG, GIF, WebP and PDF by signature', () => {
    expect(detectAttachmentMime(PNG, 'shot.png')).toBe('image/png');
    expect(detectAttachmentMime(JPEG, 'photo.jpg')).toBe('image/jpeg');
    expect(detectAttachmentMime(GIF, 'anim.gif')).toBe('image/gif');
    expect(detectAttachmentMime(WEBP, 'pic.webp')).toBe('image/webp');
    expect(detectAttachmentMime(PDF, 'doc.pdf')).toBe('application/pdf');
  });

  it('stores a PNG renamed .txt as image/png — the name never decides', () => {
    expect(detectAttachmentMime(PNG, 'notes.txt')).toBe('image/png');
    expect(detectAttachmentMime(PNG, 'no-extension')).toBe('image/png');
  });

  it('refuses a binary renamed .txt', () => {
    expect(detectAttachmentMime(BINARY, 'notes.txt')).toBeNull();
    expect(detectAttachmentMime(bytesOf([0xc3, 0x28]), 'bad.txt')).toBeNull();
  });

  it('refuses text with a NUL byte', () => {
    expect(detectAttachmentMime(bytesOf('a', [0x00], 'b'), 'a.log')).toBeNull();
  });

  it('accepts UTF-8 text under each text extension, case-insensitively', () => {
    const text = bytesOf('Ошибка: 語 — stack trace\n');
    expect(detectAttachmentMime(text, 'a.txt')).toBe('text/plain');
    expect(detectAttachmentMime(text, 'a.md')).toBe('text/markdown');
    expect(detectAttachmentMime(text, 'a.log')).toBe('text/plain');
    expect(detectAttachmentMime(text, 'a.csv')).toBe('text/csv');
    expect(detectAttachmentMime(text, 'a.json')).toBe('application/json');
    expect(detectAttachmentMime(text, 'a.diff')).toBe('text/x-diff');
    expect(detectAttachmentMime(text, 'a.PATCH')).toBe('text/x-diff');
  });

  it('refuses SVG, HTML and archives', () => {
    const svg = bytesOf('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    const html = bytesOf('<!doctype html><script>alert(1)</script>');
    expect(detectAttachmentMime(svg, 'logo.svg')).toBeNull();
    expect(detectAttachmentMime(html, 'page.html')).toBeNull();
    expect(detectAttachmentMime(ZIP, 'bundle.zip')).toBeNull();
    expect(detectAttachmentMime(ZIP, 'bundle.txt')).toBeNull();
  });

  it('refuses text under an extension that is not a text extension', () => {
    expect(detectAttachmentMime(bytesOf('hello'), 'run.sh')).toBeNull();
    expect(detectAttachmentMime(bytesOf('hello'), 'README')).toBeNull();
    expect(detectAttachmentMime(bytesOf('hello'), '.txt')).toBeNull();
  });

  it('does not take a truncated signature for a file', () => {
    expect(detectAttachmentMime(bytesOf('RIFF'), 'x.webp')).toBeNull();
    expect(detectAttachmentMime(new Uint8Array(), 'x.png')).toBeNull();
    expect(detectAttachmentMime(MP4.slice(0, 10), 'x.mp4')).toBeNull();
    expect(detectAttachmentMime(WEBM.slice(0, 4), 'x.webm')).toBeNull();
  });

  it('ADR-0090: detects MP4 and WebM by signature, whatever the name', () => {
    expect(detectAttachmentMime(MP4, 'demo.mp4')).toBe('video/mp4');
    expect(detectAttachmentMime(ftyp('mp42'), 'demo.bin')).toBe('video/mp4');
    expect(detectAttachmentMime(ftyp('avc1'), 'demo')).toBe('video/mp4');
    expect(detectAttachmentMime(WEBM, 'demo.webm')).toBe('video/webm');
    expect(detectAttachmentMime(WEBM, 'demo.txt')).toBe('video/webm');
  });

  it('ADR-0090: refuses HEIC, AVIF, QuickTime and Matroska that is not WebM', () => {
    expect(detectAttachmentMime(ftyp('heic'), 'photo.mp4')).toBeNull();
    expect(detectAttachmentMime(ftyp('avif'), 'pic.mp4')).toBeNull();
    expect(detectAttachmentMime(ftyp('qt  '), 'clip.mp4')).toBeNull();
    const mkv = bytesOf(
      [0x1a, 0x45, 0xdf, 0xa3, 0xa3, 0x42, 0x86, 0x81, 0x01, 0x42, 0x82, 0x88],
      'matroska',
    );
    expect(detectAttachmentMime(mkv, 'clip.webm')).toBeNull();
    expect(detectAttachmentMime(bytesOf('ftypisom'), 'x.mp4')).toBeNull();
  });
});

describe('detectScannedAttachmentMime — a streamed upload (#156)', () => {
  it('decides by the head and the scanned text flag, as for whole bytes', () => {
    const head = PNG.slice(0, 12);
    expect(detectScannedAttachmentMime({ head, text: false }, 'a.txt')).toBe(
      'image/png',
    );
    const text = bytesOf('hello');
    expect(
      detectScannedAttachmentMime({ head: text, text: true }, 'a.md'),
    ).toBe('text/markdown');
    expect(
      detectScannedAttachmentMime({ head: text, text: false }, 'a.md'),
    ).toBeNull();
    expect(
      detectScannedAttachmentMime({ head: text, text: true }, 'run.sh'),
    ).toBeNull();
  });
});

describe('attachmentDisposition (#309 D8)', () => {
  it('serves raster images and videos inline, everything else as a download', () => {
    const inline = ATTACHMENT_MIMES.filter(
      (m) => attachmentDisposition(m) === 'inline',
    );
    expect(inline).toEqual([
      'image/png',
      'image/jpeg',
      'image/gif',
      'image/webp',
      'video/mp4',
      'video/webm',
    ]);
    expect(attachmentDisposition('application/pdf')).toBe('attachment');
    expect(attachmentDisposition('text/plain')).toBe('attachment');
  });

  it('ADR-0090: names a video as one', () => {
    expect(isAttachmentVideo('video/mp4')).toBe(true);
    expect(isAttachmentVideo('video/webm')).toBe(true);
    expect(isAttachmentVideo('image/png')).toBe(false);
    expect(attachmentKindLabel('video/webm')).toBe('video');
  });
});

describe('names (#309 D6)', () => {
  it('keeps the original display name, cut to 200 characters', () => {
    expect(attachmentDisplayName('Screenshot 2026-10-15 at 10.01.png')).toBe(
      'Screenshot 2026-10-15 at 10.01.png',
    );
    const long = '語'.repeat(300);
    expect([...attachmentDisplayName(long)].length).toBe(ATTACHMENT_NAME_MAX);
  });

  it('keeps one line and the last path segment of a display name', () => {
    expect(attachmentDisplayName('C:\\Users\\me\\a.png')).toBe('a.png');
    expect(attachmentDisplayName('a\nb\r.txt')).toBe('a b .txt');
    expect(attachmentDisplayName('  ')).toBe(ATTACHMENT_FALLBACK_NAME);
  });

  it('maps everything outside [A-Za-z0-9._-] to _ in the safe name', () => {
    expect(attachmentSafeName('Screen shot (1).png')).toBe(
      'Screen_shot__1_.png',
    );
    expect(attachmentSafeName('../../etc/passwd')).toBe('.._.._etc_passwd');
    expect(attachmentSafeName('語.md')).toBe('_.md');
    expect(attachmentSafeName('')).toBe(ATTACHMENT_FALLBACK_NAME);
  });

  it('cuts the safe name to 80 characters with the extension kept', () => {
    const safe = attachmentSafeName(`${'a'.repeat(200)}.json`);
    expect(safe.length).toBe(ATTACHMENT_SAFE_NAME_MAX);
    expect(safe.endsWith('.json')).toBe(true);
    expect(attachmentSafeName('b'.repeat(200)).length).toBe(
      ATTACHMENT_SAFE_NAME_MAX,
    );
  });

  it('derives the file name and worktree path from the id', () => {
    expect(attachmentFileName('ck1abc', 'my shot.png')).toBe(
      'ck1abc-my_shot.png',
    );
    expect(attachmentWorktreePath('ck1abc', '../x.png')).toBe(
      '.agentdock/attachments/ck1abc-.._x.png',
    );
  });

  it('never yields a path separator', () => {
    for (const name of ['a/b', 'a\\b', '/', '..', 'a/../../b.txt']) {
      expect(attachmentFileName('id', name)).not.toMatch(/[/\\]/);
    }
  });
});

describe('contracts', () => {
  const ref = {
    id: 'ck1abc',
    name: 'shot.png',
    mime: 'image/png',
    size: 1024,
    sha256: 'a'.repeat(64),
  };

  it('accepts a valid attachment ref', () => {
    expect(attachmentRefSchema.safeParse(ref).success).toBe(true);
  });

  it('refuses a ref with a path id, a bad hash, a foreign type or an oversize file', () => {
    for (const bad of [
      { ...ref, id: '../x' },
      { ...ref, sha256: 'A'.repeat(64) },
      { ...ref, sha256: 'a'.repeat(63) },
      { ...ref, mime: 'image/svg+xml' },
      { ...ref, size: ATTACHMENT_MAX_BYTES + 1 },
      { ...ref, name: '' },
      { ...ref, extra: true },
    ]) {
      expect(attachmentRefSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('counts a ref name in characters, not UTF-16 units', () => {
    const name = '😀'.repeat(ATTACHMENT_NAME_MAX);
    expect(attachmentRefSchema.safeParse({ ...ref, name }).success).toBe(true);
    expect(
      attachmentRefSchema.safeParse({ ...ref, name: `${name}x` }).success,
    ).toBe(false);
  });

  it('parses a round snapshot', () => {
    expect(
      cardAttachmentSnapshotSchema.parse([
        { id: 'a1', name: 'x.png', mime: 'image/png' },
      ]),
    ).toEqual([{ id: 'a1', name: 'x.png', mime: 'image/png' }]);
  });

  it('builds the content and runner paths', () => {
    expect(attachmentContentPath('p1', 'a1')).toBe(
      '/projects/p1/attachments/a1/content',
    );
    expect(runnerAttachmentPath('a1')).toBe('/runner/attachments/a1');
  });
});

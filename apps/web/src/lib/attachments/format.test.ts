import { describe, expect, test } from 'bun:test';
import {
  ATTACHMENT_REFUSAL,
  type AttachmentView,
  CSRF_COOKIE,
  CSRF_HEADER,
} from '@nautelle/shared';
import {
  ATTACHMENT_NOTE,
  attachmentCountLabel,
  attachmentHref,
  canRemoveAttachment,
  csrfHeaders,
  describeRejection,
  describeUploadFailure,
  REFUSAL_TEXT,
  splitByRound,
  uploadedView,
  uploadUrl,
} from './format';

const view = (extra: Partial<AttachmentView> = {}): AttachmentView => ({
  id: 'a1',
  name: 'shot.png',
  mime: 'image/png',
  size: 10,
  createdAt: '2026-10-15T10:00:00.000Z',
  uploaderId: 'u1',
  uploaderName: 'Ann',
  roundId: null,
  contentUrl: '/projects/p1/attachments/a1/content',
  ...extra,
});

describe('describeUploadFailure', () => {
  test('every refusal code has its own sentence', () => {
    const texts = Object.values(ATTACHMENT_REFUSAL).map((code) =>
      describeUploadFailure(422, {
        error: 'attachment_error',
        code,
      }),
    );
    expect(new Set(texts).size).toBe(Object.values(ATTACHMENT_REFUSAL).length);
    expect(texts).toEqual(
      Object.values(ATTACHMENT_REFUSAL).map((code) => REFUSAL_TEXT[code]),
    );
  });

  test('size, type, count and quota say what is wrong', () => {
    expect(REFUSAL_TEXT.too_large).toContain('25 MiB');
    expect(REFUSAL_TEXT.unsupported_type).toContain('PDF');
    expect(REFUSAL_TEXT.too_many).toContain('20');
    expect(REFUSAL_TEXT.quota_exceeded).toContain('storage');
  });

  test('without a code it falls back on the status', () => {
    expect(describeUploadFailure(403, null)).toContain('role');
    expect(describeUploadFailure(409, {})).toContain('completed');
    expect(describeUploadFailure(undefined, undefined)).toContain(
      'did not reach',
    );
    expect(describeUploadFailure(500, { code: 'nonsense' })).toContain(
      'failed',
    );
  });
});

describe('describeRejection', () => {
  const file = new File(['x'], 'big.bin');
  test('names the file and the reason', () => {
    expect(describeRejection({ file, reason: 'too-large' })).toBe(
      `big.bin: ${REFUSAL_TEXT.too_large}`,
    );
    expect(describeRejection({ file, reason: 'type' })).toContain('big.bin');
    expect(describeRejection({ file, reason: 'too-many' })).toContain('20');
  });
});

describe('canRemoveAttachment', () => {
  test('the uploader and an admin, nobody else', () => {
    expect(canRemoveAttachment(view(), { id: 'u1', role: 'operator' })).toBe(
      true,
    );
    expect(canRemoveAttachment(view(), { id: 'u2', role: 'operator' })).toBe(
      false,
    );
    expect(canRemoveAttachment(view(), { id: 'u2', role: 'admin' })).toBe(true);
  });

  test('an attachment whose uploader is gone is an admin’s', () => {
    const orphan = view({ uploaderId: null });
    expect(canRemoveAttachment(orphan, { id: 'u1', role: 'operator' })).toBe(
      false,
    );
    expect(canRemoveAttachment(orphan, { id: 'u1', role: 'admin' })).toBe(true);
  });
});

describe('urls', () => {
  test('bytes go through the /api rewrite with the cookie', () => {
    expect(attachmentHref(view())).toBe(
      '/api/projects/p1/attachments/a1/content',
    );
    expect(uploadUrl('p 1')).toBe('/api/projects/p%201/attachments');
  });

  test('the CSRF header is read from the cookie', () => {
    expect(csrfHeaders(`a=b; ${CSRF_COOKIE}=t%2F1; c=d`)).toEqual({
      [CSRF_HEADER]: 't/1',
    });
    expect(csrfHeaders('a=b')).toEqual({});
  });
});

describe('uploadedView', () => {
  test('accepts an AttachmentView and nothing else', () => {
    expect(uploadedView(view())?.id).toBe('a1');
    expect(uploadedView(null)).toBeUndefined();
    expect(uploadedView({ id: 'a1' })).toBeUndefined();
    expect(
      uploadedView(view({ mime: 'image/svg+xml' as never })),
    ).toBeUndefined();
  });
});

describe('splitByRound', () => {
  test('the card’s own files apart from each round’s feedback', () => {
    const own = view({ id: 'own' });
    const r1 = view({ id: 'r1a', roundId: 'round-1' });
    const r1b = view({ id: 'r1b', roundId: 'round-1' });
    const r2 = view({ id: 'r2a', roundId: 'round-2' });
    const split = splitByRound([own, r1, r2, r1b]);
    expect(split.card.map((a) => a.id)).toEqual(['own']);
    expect(split.byRound.get('round-1')?.map((a) => a.id)).toEqual([
      'r1a',
      'r1b',
    ]);
    expect(split.byRound.get('round-2')?.map((a) => a.id)).toEqual(['r2a']);
  });
});

describe('copy', () => {
  test('the secrets note is the spec’s', () => {
    expect(ATTACHMENT_NOTE).toBe(
      'Every member of this project can open attachments. Do not attach secrets.',
    );
  });

  test('the face count pluralises', () => {
    expect(attachmentCountLabel(1)).toBe('1 attachment');
    expect(attachmentCountLabel(3)).toBe('3 attachments');
  });
});

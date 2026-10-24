import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AttachmentView } from '@nautelle/shared';
import type { BoardWorld } from '../../board/testing/board-e2e';
import type { Session } from '../../test/e2e-app';

/**
 * Points `ATTACHMENTS_DIR` at a fresh directory of this test file — call it
 * at the top of the file, before the app boots.
 */
export const useTempAttachmentsDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'agentdock-attachments-'));
  process.env.ATTACHMENTS_DIR = dir;
  return dir;
};

const bytes = (...parts: (number[] | string)[]): Buffer =>
  Buffer.concat(
    parts.map((p) => (typeof p === 'string' ? Buffer.from(p) : Buffer.from(p))),
  );

/** Enough of each format for its signature (#309 D5). */
export const FILES = {
  png: bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'IHDR-pixels'),
  pdf: bytes('%PDF-1.7\n%stub\n'),
  text: bytes('Error: boom\n  at main (app.ts:1)\n'),
  svg: bytes('<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
  html: bytes('<!doctype html><script>alert(1)</script>'),
  zip: bytes([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]),
  elf: bytes([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x00, 0x00]),
  /** ADR-0090: `ftyp` at 4 with an allowlisted major brand. */
  mp4: bytes([0x00, 0x00, 0x00, 0x18], 'ftypisom', [0, 0, 2, 0], 'isommp42'),
  /** ADR-0090: QuickTime is `ftyp` too, with a brand a browser cannot play. */
  mov: bytes([0x00, 0x00, 0x00, 0x14], 'ftypqt  ', [0, 0, 2, 0], 'qt  '),
  /** ADR-0090: the EBML magic, then the `webm` DocType. */
  webm: bytes(
    [0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0x82, 0x84],
    'webm',
    [0x42, 0x87, 0x81, 0x04],
  ),
};

/** `POST /attachments` as `session`, multipart field `file`. */
export const upload = (
  w: BoardWorld,
  name: string,
  content: Buffer = FILES.png,
  session: Session = w.operator,
  projectId = w.a,
) =>
  session
    .send('post', `${w.path(projectId)}/attachments`)
    .attach('file', content, name);

/** Uploads and expects 201; the pending view. */
export const uploaded = async (
  w: BoardWorld,
  name = 'shot.png',
  content: Buffer = FILES.png,
  session: Session = w.operator,
  projectId = w.a,
): Promise<AttachmentView> => {
  const response = await upload(w, name, content, session, projectId);
  expect(response.status).toBe(201);
  return response.body as AttachmentView;
};

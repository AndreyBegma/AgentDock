import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { ATTACHMENT_SIGNATURE_BYTES } from '@nautelle/shared';
import { FsAttachmentStore } from './attachment-store';
import {
  type ScannedUpload,
  scanBytes,
  TempFileStorage,
  UploadScanner,
} from './upload-storage';

// #156: the upload must never be read back whole — the spy proves it.
jest.mock('node:fs/promises', () => {
  const actual = jest.requireActual('node:fs/promises');
  return { ...actual, readFile: jest.fn(actual.readFile) };
});

const sha256 = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');

/** Scans `bytes` cut into chunks of `size` bytes. */
const scanInChunks = (bytes: Uint8Array, size: number): ScannedUpload => {
  const scanner = new UploadScanner();
  for (let i = 0; i < bytes.byteLength; i += size) {
    scanner.update(bytes.subarray(i, i + size));
  }
  return scanner.result();
};

describe('UploadScanner (#156)', () => {
  const text = new TextEncoder().encode(
    'Ошибка: 語 — stack trace\n'.repeat(50),
  );

  it('hashes, measures and keeps the head, whatever the chunking', () => {
    for (const size of [1, 3, 7, 4096]) {
      const scan = scanInChunks(text, size);
      expect(scan.sha256).toBe(sha256(text));
      expect(scan.size).toBe(text.byteLength);
      expect([...scan.head]).toEqual([
        ...text.subarray(0, ATTACHMENT_SIGNATURE_BYTES),
      ]);
      // A multi-byte character cut between chunks is still UTF-8.
      expect(scan.text).toBe(true);
    }
  });

  it('is not text with a NUL, invalid UTF-8 or a cut-off last character', () => {
    expect(scanBytes(new Uint8Array([0x61, 0x00, 0x62])).text).toBe(false);
    expect(scanBytes(new Uint8Array([0xc3, 0x28])).text).toBe(false);
    expect(scanInChunks(new Uint8Array([0x61, 0xe8, 0xaa]), 1).text).toBe(
      false,
    );
  });

  it('keeps a head shorter than the signature for a short file', () => {
    const scan = scanBytes(new Uint8Array([1, 2, 3]));
    expect([...scan.head]).toEqual([1, 2, 3]);
    expect(scanBytes(new Uint8Array()).head.byteLength).toBe(0);
  });
});

describe('TempFileStorage (#156)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentdock-upload-'));
  const storage = new TempFileStorage(
    new FsAttachmentStore({
      dir,
      projectQuotaBytes: 1024,
      userPendingBytes: 1024,
      sweepEnabled: false,
    }),
  );

  const handle = (stream: Readable) =>
    new Promise<{ path: string } & ScannedUpload>((resolve, reject) => {
      storage._handleFile(undefined, { stream }, (error, info) =>
        error || !info ? reject(error) : resolve(info),
      );
    });

  it('streams to a temp file and scans on the way, never reading it back', async () => {
    jest.mocked(readFile).mockClear();
    const chunk = Buffer.alloc(64 * 1024, 0x61);
    const chunks = 80; // 5 MiB
    const whole = Buffer.concat(Array.from({ length: chunks }, () => chunk));

    const info = await handle(
      Readable.from(Array.from({ length: chunks }, () => chunk)),
    );

    expect(info).toMatchObject({
      size: whole.byteLength,
      sha256: sha256(whole),
      text: true,
    });
    expect([...info.head]).toEqual([
      ...whole.subarray(0, ATTACHMENT_SIGNATURE_BYTES),
    ]);
    expect(readFile).not.toHaveBeenCalled();
    expect(sha256(readFileSync(info.path))).toBe(info.sha256);
  });

  it('removes the temp file when the stream fails', async () => {
    const stream = new Readable({
      read() {
        this.destroy(new Error('client went away'));
      },
    });
    const temp = join(dir, 'tmp');
    const before = existsSync(temp) ? await readdir(temp) : [];
    await expect(handle(stream)).rejects.toThrow('client went away');
    expect(await readdir(temp)).toEqual(before);
  });
});

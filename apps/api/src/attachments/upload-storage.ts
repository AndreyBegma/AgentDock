import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { type Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { TextDecoder } from 'node:util';
import {
  ATTACHMENT_SIGNATURE_BYTES,
  ATTACHMENT_UPLOAD_MAX_BYTES,
  type AttachmentScan,
} from '@nautelle/shared';
import type { MulterOptions } from '@nestjs/platform-express/multer/interfaces/multer-options.interface';
import type { AttachmentStore } from './attachment-store';

/** What the service needs of an upload, learned while it streamed (#156). */
export interface ScannedUpload extends AttachmentScan {
  size: number;
  sha256: string;
}

/**
 * #156: hashes an upload, keeps its first bytes for the signature and checks
 * it is `isAttachmentText` — one chunk at a time, so the whole file is never
 * in memory.
 */
export class UploadScanner {
  private readonly hash = createHash('sha256');
  private head = new Uint8Array(0);
  private size = 0;
  // Fatal: invalid UTF-8 throws; `null` once the file is known not to be text.
  private decoder: TextDecoder | null = new TextDecoder('utf-8', {
    fatal: true,
  });

  update(chunk: Uint8Array): void {
    this.hash.update(chunk);
    this.size += chunk.byteLength;
    if (this.head.byteLength < ATTACHMENT_SIGNATURE_BYTES) {
      const head = new Uint8Array(
        Math.min(
          ATTACHMENT_SIGNATURE_BYTES,
          this.head.byteLength + chunk.byteLength,
        ),
      );
      head.set(this.head);
      head.set(
        chunk.subarray(0, head.byteLength - this.head.byteLength),
        this.head.byteLength,
      );
      this.head = head;
    }
    if (this.decoder === null) return;
    if (chunk.includes(0)) {
      this.decoder = null;
      return;
    }
    try {
      this.decoder.decode(chunk, { stream: true });
    } catch {
      this.decoder = null;
    }
  }

  result(): ScannedUpload {
    let text = false;
    if (this.decoder !== null) {
      try {
        // Flushes: a multi-byte sequence cut off at the end is not UTF-8.
        this.decoder.decode();
        text = true;
      } catch {
        text = false;
      }
    }
    return {
      size: this.size,
      sha256: this.hash.digest('hex'),
      head: this.head,
      text,
    };
  }
}

/** `UploadScanner` of bytes already in memory — a Telegram photo (#594). */
export const scanBytes = (bytes: Uint8Array): ScannedUpload => {
  const scanner = new UploadScanner();
  scanner.update(bytes);
  return scanner.result();
};

type Done = (
  error: Error | null,
  info?: { path: string } & ScannedUpload,
) => void;

/**
 * D12: a multer storage engine that streams the upload to a temporary file
 * in the store's temp directory under a random name — never the client's.
 * It hashes and scans the bytes on the way (#156); the service sniffs the
 * type from that and moves the file into place.
 */
export class TempFileStorage {
  constructor(private readonly store: AttachmentStore) {}

  _handleFile(_req: unknown, file: { stream: Readable }, done: Done): void {
    void this.write(file.stream).then(
      (info) => done(null, info),
      (error: Error) => done(error),
    );
  }

  _removeFile(_req: unknown, file: { path?: string }, done: Done): void {
    if (!file.path) {
      done(null);
      return;
    }
    void rm(file.path, { force: true }).then(
      () => done(null),
      (error: Error) => done(error),
    );
  }

  private async write(
    stream: Readable,
  ): Promise<{ path: string } & ScannedUpload> {
    const path = join(
      await this.store.tempDir(),
      randomBytes(16).toString('hex'),
    );
    const scanner = new UploadScanner();
    const scan = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        scanner.update(chunk);
        callback(null, chunk);
      },
    });
    // Over the limit busboy truncates the stream and multer refuses the
    // request; the partial file is removed here, not left for the sweep.
    let truncated = false;
    stream.on('limit', () => {
      truncated = true;
    });
    try {
      await pipeline(stream, scan, createWriteStream(path, { flags: 'wx' }));
    } catch (error) {
      await rm(path, { force: true });
      throw error;
    }
    if (truncated) await rm(path, { force: true });
    return { path, ...scanner.result() };
  }
}

/** The upload route's multer options (D4, D12). */
export const uploadOptions = (store: AttachmentStore): MulterOptions => ({
  storage: new TempFileStorage(store),
  // Names arrive as UTF-8 from browsers; busboy's default is latin1.
  defParamCharset: 'utf8',
  limits: {
    fileSize: ATTACHMENT_UPLOAD_MAX_BYTES,
    files: 1,
    // A client may send a few plain fields beside the file; they are ignored.
    fields: 10,
    fieldSize: 1024,
  },
});

/** A raw request body over its limit: nothing of it is kept. */
export class UploadOverLimit extends Error {
  constructor(readonly maxBytes: number) {
    super(`the body exceeds ${maxBytes} bytes`);
    this.name = 'UploadOverLimit';
  }
}

/**
 * ADR-0089: `TempFileStorage` for a raw request body — the runner's demo
 * video. Streams it to a temporary file, scanning it on the way. Past
 * `maxBytes` the rest is read and dropped — destroying the request would
 * reset the socket before the 422 is sent — and `UploadOverLimit` is thrown
 * once it ends; a partial file is removed here. The caller moves or removes
 * the file it gets.
 */
export const receiveUpload = async (
  stream: Readable,
  store: AttachmentStore,
  maxBytes: number,
): Promise<{ path: string } & ScannedUpload> => {
  const path = join(await store.tempDir(), randomBytes(16).toString('hex'));
  const scanner = new UploadScanner();
  let size = 0;
  const scan = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.byteLength;
      if (size > maxBytes) {
        callback();
        return;
      }
      scanner.update(chunk);
      callback(null, chunk);
    },
  });
  try {
    await pipeline(stream, scan, createWriteStream(path, { flags: 'wx' }));
  } catch (error) {
    await rm(path, { force: true });
    throw error;
  }
  if (size > maxBytes) {
    await rm(path, { force: true });
    throw new UploadOverLimit(maxBytes);
  }
  return { path, ...scanner.result() };
};

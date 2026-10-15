import { randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ATTACHMENT_MAX_BYTES } from '@agentdock/shared';
import type { MulterOptions } from '@nestjs/platform-express/multer/interfaces/multer-options.interface';
import type { AttachmentStore } from './attachment-store';

type Done = (
  error: Error | null,
  info?: { path: string; size: number },
) => void;

/**
 * D12: a multer storage engine that streams the upload to a temporary file
 * in the store's temp directory under a random name — never the client's.
 * The service hashes, sniffs and moves it into place.
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
  ): Promise<{ path: string; size: number }> {
    const path = join(
      await this.store.tempDir(),
      randomBytes(16).toString('hex'),
    );
    let size = 0;
    stream.on('data', (chunk: Buffer) => {
      size += chunk.length;
    });
    // Over the limit busboy truncates the stream and multer refuses the
    // request; the partial file is removed here, not left for the sweep.
    let truncated = false;
    stream.on('limit', () => {
      truncated = true;
    });
    try {
      await pipeline(stream, createWriteStream(path, { flags: 'wx' }));
    } catch (error) {
      await rm(path, { force: true });
      throw error;
    }
    if (truncated) await rm(path, { force: true });
    return { path, size };
  }
}

/** The upload route's multer options (D4, D12). */
export const uploadOptions = (store: AttachmentStore): MulterOptions => ({
  storage: new TempFileStorage(store),
  // Names arrive as UTF-8 from browsers; busboy's default is latin1.
  defParamCharset: 'utf8',
  limits: {
    fileSize: ATTACHMENT_MAX_BYTES,
    files: 1,
    // A client may send a few plain fields beside the file; they are ignored.
    fields: 10,
    fieldSize: 1024,
  },
});

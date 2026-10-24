import { createReadStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { Inject, Injectable } from '@nestjs/common';
import type { ByteRange } from './attachment-range';
import {
  ATTACHMENTS_OPTIONS,
  type AttachmentsOptions,
} from './attachments-options';
import { ATTACHMENT_ID_PATTERN } from './dto';

/** One stored file, as the sweep sees it. */
export interface StoredAttachment {
  projectId: string;
  id: string;
  modifiedAt: Date;
}

/** A temporary upload, as the sweep sees it. */
export interface StoredTemp {
  name: string;
  modifiedAt: Date;
}

/**
 * D2 (ADR-0031 §1): where attachment bytes live. Every caller goes through
 * this port, so an S3-compatible store can be a second implementation. Keys
 * are a project id and an attachment id — never a name from the user.
 */
export abstract class AttachmentStore {
  /** Where an upload streams to before it is checked (D12). */
  abstract tempDir(): Promise<string>;
  /** Moves a checked temporary file into place, atomically. */
  abstract put(projectId: string, id: string, tempPath: string): Promise<void>;
  /**
   * The bytes — only `range`'s, inclusive, when given (ADR-0089); rejects
   * when the file is missing.
   */
  abstract open(
    projectId: string,
    id: string,
    range?: ByteRange,
  ): Promise<Readable>;
  /** Idempotent: a missing file is not an error. */
  abstract remove(projectId: string, id: string): Promise<void>;
  /** Every stored file (the orphan sweep). */
  abstract list(): AsyncIterable<StoredAttachment>;
  /** Every temporary upload (the orphan sweep). */
  abstract temps(): Promise<StoredTemp[]>;
  abstract removeTemp(name: string): Promise<void>;
}

const TEMP_DIR = 'tmp';

/** A key segment must be a plain token: no separator, no `..`, never empty. */
const segment = (value: string): string => {
  if (!ATTACHMENT_ID_PATTERN.test(value)) {
    throw new Error(`not an attachment store key: ${JSON.stringify(value)}`);
  }
  return value;
};

const isMissing = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException).code === 'ENOENT';

/** D2: `ATTACHMENTS_DIR/<projectId>/<attachmentId>`, uploads in `ATTACHMENTS_DIR/tmp`. */
@Injectable()
export class FsAttachmentStore extends AttachmentStore {
  constructor(
    @Inject(ATTACHMENTS_OPTIONS) private readonly options: AttachmentsOptions,
  ) {
    super();
  }

  private path(projectId: string, id: string): string {
    return join(this.options.dir, segment(projectId), segment(id));
  }

  async tempDir(): Promise<string> {
    const dir = join(this.options.dir, TEMP_DIR);
    await mkdir(dir, { recursive: true });
    return dir;
  }

  async put(projectId: string, id: string, tempPath: string): Promise<void> {
    const target = this.path(projectId, id);
    await mkdir(join(this.options.dir, segment(projectId)), {
      recursive: true,
    });
    await rename(tempPath, target);
  }

  async open(
    projectId: string,
    id: string,
    range?: ByteRange,
  ): Promise<Readable> {
    const path = this.path(projectId, id);
    // `createReadStream` reports a missing file only once read; ask first.
    await stat(path);
    return createReadStream(path, range);
  }

  async remove(projectId: string, id: string): Promise<void> {
    await rm(this.path(projectId, id), { force: true });
  }

  async *list(): AsyncIterable<StoredAttachment> {
    let projects: string[];
    try {
      projects = await readdir(this.options.dir);
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    for (const projectId of projects) {
      if (projectId === TEMP_DIR || !ATTACHMENT_ID_PATTERN.test(projectId)) {
        continue;
      }
      let ids: string[];
      try {
        ids = await readdir(join(this.options.dir, projectId));
      } catch (error) {
        // Not a directory, or removed meanwhile.
        if (
          isMissing(error) ||
          (error as NodeJS.ErrnoException).code === 'ENOTDIR'
        ) {
          continue;
        }
        throw error;
      }
      for (const id of ids) {
        if (!ATTACHMENT_ID_PATTERN.test(id)) continue;
        try {
          const info = await stat(join(this.options.dir, projectId, id));
          if (info.isFile()) {
            yield { projectId, id, modifiedAt: info.mtime };
          }
        } catch (error) {
          if (!isMissing(error)) throw error;
        }
      }
    }
  }

  async temps(): Promise<StoredTemp[]> {
    const dir = join(this.options.dir, TEMP_DIR);
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    const found: StoredTemp[] = [];
    for (const name of names) {
      if (!ATTACHMENT_ID_PATTERN.test(name)) continue;
      try {
        const info = await stat(join(dir, name));
        found.push({ name, modifiedAt: info.mtime });
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    }
    return found;
  }

  async removeTemp(name: string): Promise<void> {
    await rm(join(this.options.dir, TEMP_DIR, segment(name)), { force: true });
  }
}

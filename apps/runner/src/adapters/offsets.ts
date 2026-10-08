import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { sessionObservedDataSchema } from '@agentdock/shared/protocol';
import { z } from 'zod';
import { errorMessage, type Logger } from '../log';
import type { FileState } from './types';

const OFFSETS_VERSION = 1;

const fileStateSchema = z.object({
  offset: z.number().int().nonnegative(),
  observed: sessionObservedDataSchema.nullable().catch(null),
  parser: z.unknown(),
});

const offsetsFileSchema = z.object({
  v: z.literal(OFFSETS_VERSION),
  files: z.record(z.string(), fileStateSchema),
});

/**
 * Where each transcript was read up to (D5), in
 * `$XDG_STATE_HOME/agentdock/offsets.json`, so a restart resumes instead of
 * re-sending. Written atomically; an unreadable file starts empty, which only
 * re-sends events the API already deduplicates.
 */
export class OffsetStore {
  private constructor(
    private readonly path: string,
    private readonly files: Map<string, FileState>,
  ) {}

  static load(path: string, log: Logger): OffsetStore {
    const files = new Map<string, FileState>();
    if (existsSync(path)) {
      try {
        const parsed = offsetsFileSchema.parse(
          JSON.parse(readFileSync(path, 'utf8')),
        );
        for (const [file, state] of Object.entries(parsed.files)) {
          files.set(file, {
            offset: state.offset,
            observed: state.observed,
            parser: state.parser ?? null,
          });
        }
      } catch (error) {
        log.warn('sessions: offsets unreadable, starting afresh', {
          error: errorMessage(error),
        });
      }
    }
    return new OffsetStore(path, files);
  }

  get(file: string): FileState | undefined {
    return this.files.get(file);
  }

  set(file: string, state: FileState): void {
    this.files.set(file, state);
  }

  delete(file: string): void {
    this.files.delete(file);
  }

  entries(): IterableIterator<[string, FileState]> {
    return this.files.entries();
  }

  /** Temp file, fsync, rename: a crash leaves the old file or the new one. */
  save(): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const body = JSON.stringify({
      v: OFFSETS_VERSION,
      files: Object.fromEntries(this.files),
    });
    const tmp = `${this.path}.${process.pid}.tmp`;
    const fd = openSync(tmp, 'w', 0o600);
    try {
      writeSync(fd, body);
      fsyncSync(fd);
    } catch (error) {
      closeSync(fd);
      rmSync(tmp, { force: true });
      throw error;
    }
    closeSync(fd);
    renameSync(tmp, this.path);
  }
}

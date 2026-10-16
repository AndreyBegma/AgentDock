import {
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { FILTER_RAW_DIR } from './env';

/** One raw file holds at most this much of a command's output (amendment 6). */
export const RAW_CAP_BYTES = 10 * 1024 * 1024;

/** Appended to a raw file cut at the cap. */
export const RAW_TRUNCATED_MARKER = `\n[agentdock filter: raw output truncated at ${RAW_CAP_BYTES / 1024 / 1024} MB]\n`;

/**
 * A command's raw output on disk: `<run dir>/raw/<n>.log` (D4a). `n` is the
 * next free number, claimed with an exclusive create, so concurrent filters
 * of one session never share a file.
 */
export class RawFile {
  private written = 0;
  private cut = false;

  private constructor(
    readonly path: string,
    private readonly fd: number,
    private readonly cap: number,
  ) {}

  static create(runDir: string, cap = RAW_CAP_BYTES): RawFile {
    const dir = join(runDir, FILTER_RAW_DIR);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    let n = readdirSync(dir).length + 1;
    for (;;) {
      const path = join(dir, `${n}.log`);
      try {
        return new RawFile(path, openSync(path, 'wx', 0o600), cap);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        n += 1;
      }
    }
  }

  /** Whether the output went past the cap and the file was cut. */
  get truncated(): boolean {
    return this.cut;
  }

  write(chunk: Uint8Array): void {
    if (this.cut) return;
    const room = this.cap - this.written;
    if (chunk.byteLength > room) {
      if (room > 0) writeSync(this.fd, chunk.subarray(0, room));
      writeSync(this.fd, RAW_TRUNCATED_MARKER);
      this.written = this.cap;
      this.cut = true;
      return;
    }
    writeSync(this.fd, chunk);
    this.written += chunk.byteLength;
  }

  close(): void {
    closeSync(this.fd);
  }
}

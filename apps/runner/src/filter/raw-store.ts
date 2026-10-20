import {
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { FILTER_RAW_DIR } from './env';

/** One raw file holds at most this much of a command's output (amendment 6). */
export const RAW_CAP_BYTES = 10 * 1024 * 1024;

/**
 * All raw files of one run dir together stay under this (DR-07): before a new
 * file, the oldest go until there is room for one more at its own cap.
 */
export const RAW_DIR_CAP_BYTES = 200 * 1024 * 1024;

const RAW_NAME = /^(\d+)\.log$/;

/** Deletes `<n>.log` files, lowest `n` first, until they total at most `keep`. */
const pruneOldest = (dir: string, names: readonly string[], keep: number) => {
  const files: { path: string; n: number; size: number }[] = [];
  let total = 0;
  for (const name of names) {
    const n = RAW_NAME.exec(name)?.[1];
    if (n === undefined) continue;
    const path = join(dir, name);
    try {
      const size = lstatSync(path).size;
      files.push({ path, n: Number(n), size });
      total += size;
    } catch {
      // Gone already: another filter pruned it.
    }
  }
  files.sort((a, b) => a.n - b.n);
  for (const file of files) {
    if (total <= keep) break;
    try {
      unlinkSync(file.path);
    } catch {
      // Gone already.
    }
    total -= file.size;
  }
};

/**
 * Removes a run dir's raw outputs (amendment 6: they go with the run). For
 * the launches whose run dir outlives the run — a card's rounds, the
 * orchestrator's session dir. Never throws.
 */
export const removeRawDir = (runDir: string): void => {
  try {
    rmSync(join(runDir, FILTER_RAW_DIR), { recursive: true, force: true });
  } catch {
    // Nothing to remove, or not ours to remove: the run is over either way.
  }
};

/** Appended to a raw file cut at the cap. */
export const RAW_TRUNCATED_MARKER = `\n[nautelle filter: raw output truncated at ${RAW_CAP_BYTES / 1024 / 1024} MB]\n`;

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

  static create(
    runDir: string,
    cap = RAW_CAP_BYTES,
    dirCap = RAW_DIR_CAP_BYTES,
  ): RawFile {
    const dir = join(runDir, FILTER_RAW_DIR);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const names = readdirSync(dir);
    pruneOldest(dir, names, Math.max(0, dirCap - cap));
    let n = names.length + 1;
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

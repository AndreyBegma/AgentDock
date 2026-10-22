import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';

/** The most a file an agent writes (a message, a reply) may hold. */
export const AGENT_FILE_MAX_BYTES = 1024 * 1024;

/**
 * Reads `rel` under `root` as text, only when it is a regular file that really
 * lives inside `root` and holds at most `maxBytes`. A symlink (even one that
 * points inside), a FIFO or device, a path that escapes `root`, an oversized
 * file or any error gives null — and an oversized file is never read.
 * The agent that writes these files runs as the runner's user, so what it
 * leaves in its worktree is not trusted.
 */
export const readRegularFileInside = (
  root: string,
  rel: string,
  maxBytes: number,
): string | null => {
  const path = join(root, rel);
  let fd: number | undefined;
  try {
    if (!lstatSync(path).isFile()) return null;
    // O_NONBLOCK: a FIFO swapped in after the lstat must not block the open.
    fd = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes) return null;
    const inside = relative(realpathSync(root), realpathSync(path));
    if (inside === '' || inside.startsWith(`..${sep}`) || inside === '..') {
      return null;
    }
    if (isAbsolute(inside)) return null;
    const buffer = Buffer.alloc(stat.size);
    let read = 0;
    while (read < buffer.length) {
      const n = readSync(fd, buffer, read, buffer.length - read, read);
      if (n === 0) break;
      read += n;
    }
    return buffer.toString('utf8', 0, read);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
};

/** A capped read: the text, or — for a file over the cap, never read — its size. */
export type CappedRead = { ok: true; text: string } | { ok: false; size: number };

/**
 * Reads `path` as text when it is a regular file of at most `maxBytes`. An
 * oversized file is reported by its size and never read; a missing file, a
 * directory or any error gives null.
 */
export const readFileCapped = (
  path: string,
  maxBytes: number,
): CappedRead | null => {
  let fd: number | undefined;
  try {
    // O_NONBLOCK: a FIFO in the file's place must not block the open.
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile()) return null;
    if (stat.size > maxBytes) return { ok: false, size: stat.size };
    // Up to the size the stat saw: a file growing meanwhile never reads past the cap.
    const buffer = Buffer.alloc(stat.size);
    let read = 0;
    while (read < buffer.length) {
      const n = readSync(fd, buffer, read, buffer.length - read, read);
      if (n === 0) break;
      read += n;
    }
    return { ok: true, text: buffer.toString('utf8', 0, read) };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
};

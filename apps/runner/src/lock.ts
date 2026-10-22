import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  linkSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';

export class LockError extends Error {}

/** Who holds a lock: a pid, and when that process started (null when unknown). */
export interface LockOwner {
  pid: number;
  start: string | null;
}

/**
 * When `pid` started, as the OS reports it — a pid reused by a later process
 * reads differently. Null when the process is gone or the OS cannot say.
 */
export const processStart = (pid: number): string | null => {
  try {
    if (process.platform === 'linux') {
      // `pid (comm) state …`: comm may hold spaces and parens, so fields are
      // counted after the last `)`; starttime is field 22, the 20th after it.
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? null;
    }
    const ps = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
    });
    return (ps.status === 0 && ps.stdout.trim()) || null;
  } catch {
    return null;
  }
};

const currentProcess = (): LockOwner => ({
  pid: process.pid,
  start: processStart(process.pid),
});

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/** Alive, and — when both start times are known — the same process, not a reuse of its pid. */
const isHeld = (owner: LockOwner): boolean => {
  if (!isAlive(owner.pid)) return false;
  if (owner.start === null) return true;
  const start = processStart(owner.pid);
  return start === null || start === owner.start;
};

const format = (owner: LockOwner): string =>
  owner.start === null ? `${owner.pid}\n` : `${owner.pid} ${owner.start}\n`;

/** `<pid>[ <start>]\n`; null when the text is not one. */
const parse = (text: string): LockOwner | null => {
  const match = /^(\d+)(?: (\S+))?\n?$/.exec(text);
  if (!match) return null;
  return { pid: Number(match[1]), start: match[2] ?? null };
};

const readText = (path: string): string | null => {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
};

/** `link` fails when `path` exists: an exclusive create whose content is already complete. */
const linkExclusive = (temp: string, path: string): boolean => {
  try {
    linkSync(temp, path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
};

/**
 * Replaces the stale lock `staleText` with ours. Only the holder of
 * `<path>.takeover` may replace it, and it does so only while the lock still
 * reads stale; it then re-reads the lock and loses unless it reads its own.
 * Two daemons starting at once over the same stale lock: one wins, the other
 * gets a `LockError`.
 */
const takeOver = (
  path: string,
  temp: string,
  content: string,
  staleText: string,
): void => {
  const guard = `${path}.takeover`;
  if (!linkExclusive(temp, guard)) {
    const holder = parse(readText(guard) ?? '');
    if (holder && isHeld(holder)) {
      throw new LockError(
        `another nautelle-runner is starting (pid ${holder.pid})`,
      );
    }
    // A takeover that died midway left its guard behind.
    rmSync(guard, { force: true });
    if (!linkExclusive(temp, guard)) {
      throw new LockError(`another nautelle-runner is starting`);
    }
  }
  try {
    const current = readText(path);
    if (current === null) {
      if (!linkExclusive(temp, path)) throw lost(path);
    } else if (current === staleText) {
      renameSync(temp, path);
    } else {
      throw lost(path);
    }
    if (readText(path) !== content) throw lost(path);
  } finally {
    if (readText(guard) === content) rmSync(guard, { force: true });
  }
};

const lost = (path: string): LockError =>
  new LockError(`another nautelle-runner took the lock ${path}`);

/**
 * One daemon per spool: two writers would interleave `seq`. Creates `path`
 * exclusively with our pid and start time; a lock whose owner is gone (or
 * whose pid now names another process) is taken over atomically
 * (`takeOver`). Returns the release function, which removes the lock only
 * while it is still ours.
 */
export const acquireLock = (
  path: string,
  self: LockOwner = currentProcess(),
): (() => void) => {
  const content = format(self);
  const release = () => {
    if (readText(path) === content) rmSync(path, { force: true });
  };
  const temp = `${path}.${self.pid}-${randomBytes(6).toString('hex')}`;
  writeFileSync(temp, content, { flag: 'wx', mode: 0o600 });
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (linkExclusive(temp, path)) return release;
      const text = readText(path);
      // Released between the link and the read: try the link again.
      if (text === null) continue;
      const owner = parse(text);
      if (owner && owner.pid !== self.pid && isHeld(owner)) {
        throw new LockError(
          `another nautelle-runner is running (pid ${owner.pid})`,
        );
      }
      takeOver(path, temp, content, text);
      return release;
    }
    throw new LockError(`cannot take the lock ${path}`);
  } finally {
    rmSync(temp, { force: true });
  }
};

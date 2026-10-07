import { readFileSync, rmSync, writeFileSync } from 'node:fs';

export class LockError extends Error {}

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/**
 * One daemon per spool: two writers would interleave `seq`. Creates `path`
 * exclusively with our pid; a lock left by a dead process is taken over.
 * Returns the release function.
 */
export const acquireLock = (path: string, pid = process.pid): (() => void) => {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(path, `${pid}\n`, { flag: 'wx', mode: 0o600 });
      return () => rmSync(path, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const owner = Number.parseInt(readFileSync(path, 'utf8'), 10);
    if (Number.isInteger(owner) && owner !== pid && isAlive(owner)) {
      throw new LockError(`another agentdock-runner is running (pid ${owner})`);
    }
    rmSync(path, { force: true });
  }
  throw new LockError(`cannot take the lock ${path}`);
};

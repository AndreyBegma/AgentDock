import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { RUNNER_CLOSE_CODES } from '@nautelle/shared/protocol';

/**
 * Why the daemon last stopped for good — a terminal close — so
 * `nautelle-runner status` can say it after the process is gone. A replaced
 * connection may be another process holding this runner's token (C-108).
 */
export interface StopStatus {
  code: number;
  reason: string;
  /** ISO time of the close. */
  at: string;
}

/** The line `status` prints for a stop, and the daemon logs as it stops. */
export const stopMessage = (status: StopStatus): string => {
  switch (status.code) {
    case RUNNER_CLOSE_CODES.replaced:
      return `replaced by another connection at ${status.at}, re-pair if this was not you`;
    case RUNNER_CLOSE_CODES.unauthorized:
      return `refused by the server (token revoked or unknown) at ${status.at}, pair again`;
    case RUNNER_CLOSE_CODES.protocolMismatch:
      return `protocol not supported by the server at ${status.at} (${status.reason}), upgrade the runner`;
    default:
      return `closed by the server with ${status.code} at ${status.at}: ${status.reason}`;
  }
};

export const writeStopStatus = (path: string, status: StopStatus): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(status)}\n`, { mode: 0o600 });
};

/** Null when there is none, or it cannot be read as one. */
export const readStopStatus = (path: string): StopStatus | null => {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<StopStatus>;
    return typeof value.code === 'number' &&
      typeof value.reason === 'string' &&
      typeof value.at === 'string'
      ? { code: value.code, reason: value.reason, at: value.at }
      : null;
  } catch {
    return null;
  }
};

/** A new `run` starts clean: the last stop is no longer the current state. */
export const clearStopStatus = (path: string): void => {
  rmSync(path, { force: true });
};

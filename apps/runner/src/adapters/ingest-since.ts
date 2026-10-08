import type { Clock } from '../clock';
import { loadConfig, type RunnerConfig, saveConfig } from '../config';
import { errorMessage, type Logger } from '../log';

/**
 * `sessions.ingestSince` (D11). `pair` sets it; a config paired before
 * sessions existed gets the first start's time, written back so a restart
 * keeps it. Without it, a fresh runner would upload months of history unasked.
 */
export const resolveIngestSince = (
  config: RunnerConfig,
  configFile: string,
  clock: Clock,
  log: Logger,
): Date => {
  if (config.sessions.ingestSince) return new Date(config.sessions.ingestSince);
  const now = new Date(clock.now());
  try {
    const current = loadConfig(configFile);
    saveConfig(configFile, {
      ...current,
      sessions: { ...current.sessions, ingestSince: now.toISOString() },
    });
  } catch (error) {
    log.warn('sessions: cannot record ingestSince', {
      error: errorMessage(error),
    });
  }
  return now;
};

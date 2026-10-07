import type { Env } from './env';

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  /** Every later line has this value replaced by `[redacted]`, wherever it appears. */
  addSecret(secret: string): void;
}

export const REDACTED = '[redacted]';

/** Keys whose value is never written, whatever it is. */
const SECRET_KEYS = new Set(['token', 'authorization']);

export const parseLogLevel = (env: Env): LogLevel => {
  const value = env.AGENTDOCK_LOG?.toLowerCase();
  return LOG_LEVELS.find((l) => l === value) ?? 'info';
};

export interface LoggerOptions {
  level: LogLevel;
  /** Receives one complete line, newline included. */
  write: (line: string) => void;
  now?: () => Date;
}

/** JSON lines, one per call (D12). */
export const createLogger = (options: LoggerOptions): Logger => {
  const secrets = new Set<string>();
  const threshold = LOG_LEVELS.indexOf(options.level);
  const now = options.now ?? (() => new Date());

  const replacer = (key: string, value: unknown): unknown => {
    if (SECRET_KEYS.has(key.toLowerCase())) return REDACTED;
    if (value instanceof Error) return value.message;
    return value;
  };

  const line = (level: LogLevel, msg: string, fields: LogFields = {}) => {
    if (LOG_LEVELS.indexOf(level) < threshold) return;
    let text = JSON.stringify(
      { ts: now().toISOString(), level, msg, ...fields },
      replacer,
    );
    for (const secret of secrets) text = text.replaceAll(secret, REDACTED);
    options.write(`${text}\n`);
  };

  return {
    debug: (msg, fields) => line('debug', msg, fields),
    info: (msg, fields) => line('info', msg, fields),
    warn: (msg, fields) => line('warn', msg, fields),
    error: (msg, fields) => line('error', msg, fields),
    addSecret: (secret) => {
      if (secret.length > 0) secrets.add(secret);
    },
  };
};

/** The message of anything thrown, first line only — never a stack trace. */
export const errorMessage = (error: unknown): string => {
  const text = error instanceof Error ? error.message : String(error);
  return text.split('\n')[0].slice(0, 500);
};

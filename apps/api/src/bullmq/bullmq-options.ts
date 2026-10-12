import type { ConfigService } from '@nestjs/config';
import type { ConnectionOptions } from 'bullmq';

/** Every BullMQ key lives under this prefix (spec 123 B19); BullMQ's default is `bull`. */
export const QUEUE_PREFIX = 'agentdock';

/** Whether this instance talks to Redis at all (spec 123 B19). */
export const QUEUE_ENABLED = Symbol('QUEUE_ENABLED');

export const REDIS_URL_REQUIRED =
  'REDIS_URL is required unless SCHEDULER_ENABLED=false';

export interface QueueOptions {
  enabled: boolean;
  redisUrl: string | undefined;
  prefix: string;
}

/**
 * Redis is needed while the scheduler is on. `SCHEDULER_ENABLED=false` with no
 * `REDIS_URL` is the one way to run without it; any other combination without
 * a URL refuses to boot rather than silently never firing a schedule.
 */
export const queueOptions = (config: ConfigService): QueueOptions => {
  const redisUrl = config.get<string>('REDIS_URL')?.trim() || undefined;
  const schedulerOff = config.get<string>('SCHEDULER_ENABLED') === 'false';
  if (!redisUrl && !schedulerOff) throw new Error(REDIS_URL_REQUIRED);
  return {
    enabled: redisUrl !== undefined,
    redisUrl,
    // Overridden by the e2e suite only, so a run owns its keys (spec 123).
    prefix: config.get<string>('QUEUE_PREFIX')?.trim() || QUEUE_PREFIX,
  };
};

/**
 * ioredis options from a `redis://[:password@]host:port/db` URL. BullMQ's
 * workers require `maxRetriesPerRequest: null`; it is harmless for producers.
 */
export const redisConnection = (url: string): ConnectionOptions => {
  const parsed = new URL(url);
  if (parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:') {
    throw new Error(`REDIS_URL must be a redis:// or rediss:// URL`);
  }
  const db = parsed.pathname.replace(/^\//, '');
  return {
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 6379,
    username: parsed.username ? decodeURIComponent(parsed.username) : undefined,
    password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
    db: db ? Number(db) : 0,
    ...(parsed.protocol === 'rediss:' ? { tls: {} } : {}),
    maxRetriesPerRequest: null,
  };
};

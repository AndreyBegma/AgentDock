import type { ConfigService } from '@nestjs/config';
import {
  QUEUE_PREFIX,
  queueOptions,
  REDIS_URL_REQUIRED,
  redisConnection,
} from './bullmq-options';

const config = (env: Record<string, string>) =>
  ({ get: (key: string) => env[key] }) as unknown as ConfigService;

describe('queueOptions', () => {
  it('is enabled with a URL and uses the agentdock prefix', () => {
    expect(
      queueOptions(config({ REDIS_URL: 'redis://localhost:6421' })),
    ).toEqual({
      enabled: true,
      redisUrl: 'redis://localhost:6421',
      prefix: QUEUE_PREFIX,
    });
    expect(QUEUE_PREFIX).toBe('agentdock');
  });

  it('refuses to boot without a URL while the scheduler is on', () => {
    expect(() => queueOptions(config({}))).toThrow(REDIS_URL_REQUIRED);
    expect(() => queueOptions(config({ REDIS_URL: '  ' }))).toThrow(
      REDIS_URL_REQUIRED,
    );
    expect(() => queueOptions(config({ SCHEDULER_ENABLED: 'true' }))).toThrow(
      REDIS_URL_REQUIRED,
    );
  });

  it('runs without Redis only when the scheduler is off', () => {
    expect(queueOptions(config({ SCHEDULER_ENABLED: 'false' })).enabled).toBe(
      false,
    );
  });

  it('still connects when the scheduler is off but a URL is set', () => {
    expect(
      queueOptions(
        config({ SCHEDULER_ENABLED: 'false', REDIS_URL: 'redis://h:1' }),
      ).enabled,
    ).toBe(true);
  });
});

describe('redisConnection', () => {
  it('parses host, port, password and database', () => {
    expect(redisConnection('redis://:p%40ss@cache:6421/1')).toMatchObject({
      host: 'cache',
      port: 6421,
      password: 'p@ss',
      db: 1,
      maxRetriesPerRequest: null,
    });
  });

  it('defaults the port and database', () => {
    expect(redisConnection('redis://localhost')).toMatchObject({
      host: 'localhost',
      port: 6379,
      db: 0,
    });
  });

  it('rejects other schemes', () => {
    expect(() => redisConnection('http://localhost')).toThrow(/redis:\/\//);
  });
});

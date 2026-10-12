import { Queue } from 'bullmq';
import { redisConnection } from './bullmq-options';

/** A prefix of its own per run, so parallel runs never see each other's jobs. */
export const testQueuePrefix = (): string =>
  `agentdock-test-${process.pid}-${Date.now()}`;

/** Removes every key of the named queues under `prefix`. For e2e teardown. */
export const obliterateQueues = async (
  redisUrl: string,
  prefix: string,
  names: string[],
): Promise<void> => {
  for (const name of names) {
    const queue = new Queue(name, {
      connection: redisConnection(redisUrl),
      prefix,
    });
    try {
      await queue.obliterate({ force: true });
    } finally {
      await queue.close();
    }
  }
};

/** Resolves when Redis answers, rejects after `timeoutMs`. */
export const assertRedisReachable = async (
  redisUrl: string,
  timeoutMs = 5000,
): Promise<void> => {
  const queue = new Queue('connectivity-check', {
    connection: { ...redisConnection(redisUrl), retryStrategy: () => null },
    prefix: 'agentdock-test-connectivity',
  });
  queue.on('error', () => undefined);
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      queue.waitUntilReady(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`no answer within ${timeoutMs} ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    await queue.close().catch(() => undefined);
  }
};

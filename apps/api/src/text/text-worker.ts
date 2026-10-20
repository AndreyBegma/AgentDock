import { TEXT_NORMALIZE_QUEUE } from '@nautelle/shared';
import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DelayedError, type Job, Worker } from 'bullmq';
import { type NormalizeOutcome, TextNormalizer } from './text-normalizer';
import { type TextJobData, TextQueue } from './text-queue';

/** Requests one instance starts at once; each only sends a command. */
const CONCURRENCY = 2;
const CLOSE_TIMEOUT_MS = 10_000;
const ERROR_LOG_INTERVAL_MS = 60_000;

/**
 * Runs the `text-normalize` queue on this instance (issue #271 D3, D11), as
 * the capture worker does: created on bootstrap, not under `APP_ENV=test` or
 * `SCHEDULER_ENABLED=false` — e2e suites drive `process` themselves. A
 * deferred request goes back to the delayed set under its own id.
 */
@Injectable()
export class TextWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(TextWorker.name);
  private worker: Worker<TextJobData> | undefined;

  constructor(
    private readonly normalizer: TextNormalizer,
    private readonly queue: TextQueue,
    private readonly config: ConfigService,
  ) {}

  onApplicationBootstrap(): void {
    const enabled =
      this.config.get<string>('SCHEDULER_ENABLED') !== 'false' &&
      this.config.get<string>('APP_ENV') !== 'test';
    if (!enabled) return;
    if (!this.queue.queue) {
      this.logger.log(
        'no REDIS_URL: text normalization does not run on this instance',
      );
      return;
    }
    this.start();
  }

  async onModuleDestroy(): Promise<void> {
    const worker = this.worker;
    if (!worker) return;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        worker.close(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('timeout')),
            CLOSE_TIMEOUT_MS,
          );
        }),
      ]);
    } catch {
      this.logger.warn('text-normalize worker did not close in time; forcing');
      await worker.close(true);
    } finally {
      clearTimeout(timer);
    }
  }

  start(): Worker<TextJobData> {
    const queue = this.queue.queue;
    if (!queue) throw new Error('text-normalize queue is not registered');
    const worker = new Worker<TextJobData>(
      TEXT_NORMALIZE_QUEUE,
      (job, token) => this.process(job, token),
      {
        connection: queue.opts.connection,
        prefix: queue.opts.prefix,
        concurrency: CONCURRENCY,
      },
    );
    const logged = new Map<string, number>();
    worker.on('error', (error) => {
      const last = logged.get(error.message) ?? 0;
      if (Date.now() - last < ERROR_LOG_INTERVAL_MS) return;
      logged.set(error.message, Date.now());
      this.logger.warn(`text-normalize worker: ${error.message}`);
    });
    worker.on('failed', (job, error) => {
      this.logger.error(
        `text-normalize job ${job?.id ?? '?'} failed: ${error.message}`,
      );
    });
    this.worker = worker;
    return worker;
  }

  async process(
    job: Job<TextJobData>,
    token?: string,
  ): Promise<NormalizeOutcome> {
    const outcome = await this.normalizer.process(job.data);
    if (outcome.kind !== 'deferred') return outcome;
    if (outcome.data !== undefined && Object.keys(outcome.data).length > 0) {
      await job.updateData({ ...job.data, ...outcome.data });
    }
    await job.moveToDelayed(outcome.untilMs, token);
    throw new DelayedError();
  }
}

import { CARD_ASSESS_QUEUE } from '@agentdock/shared';
import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DelayedError, type Job, Worker } from 'bullmq';
import { type AssessJobData, AssessQueue } from './assess-queue';
import { type AssessOutcome, CardAssessor } from './card-assessor';

/** Jobs one instance runs at once; each only sends a command. */
const CONCURRENCY = 2;
const CLOSE_TIMEOUT_MS = 10_000;
const ERROR_LOG_INTERVAL_MS = 60_000;

/**
 * Runs the `card-assess` queue on this instance (issue #322 D6), as the text
 * worker does: created on bootstrap, not under `APP_ENV=test` or
 * `SCHEDULER_ENABLED=false` — e2e suites drive `process` themselves. A
 * deferred job goes back to the delayed set under its own id.
 */
@Injectable()
export class AssessWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(AssessWorker.name);
  private worker: Worker<AssessJobData> | undefined;

  constructor(
    private readonly assessor: CardAssessor,
    private readonly queue: AssessQueue,
    private readonly config: ConfigService,
  ) {}

  onApplicationBootstrap(): void {
    const enabled =
      this.config.get<string>('SCHEDULER_ENABLED') !== 'false' &&
      this.config.get<string>('APP_ENV') !== 'test';
    if (!enabled) return;
    if (!this.queue.queue) {
      this.logger.log('no REDIS_URL: cards are not assessed on this instance');
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
      this.logger.warn('card-assess worker did not close in time; forcing');
      await worker.close(true);
    } finally {
      clearTimeout(timer);
    }
  }

  start(): Worker<AssessJobData> {
    const queue = this.queue.queue;
    if (!queue) throw new Error('card-assess queue is not registered');
    const worker = new Worker<AssessJobData>(
      CARD_ASSESS_QUEUE,
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
      this.logger.warn(`card-assess worker: ${error.message}`);
    });
    worker.on('failed', (job, error) => {
      this.logger.error(
        `card-assess job ${job?.id ?? '?'} failed: ${error.message}`,
      );
    });
    this.worker = worker;
    return worker;
  }

  async process(
    job: Job<AssessJobData>,
    token?: string,
  ): Promise<AssessOutcome> {
    const outcome = await this.assessor.process(job.data);
    if (outcome.kind !== 'deferred') return outcome;
    await job.moveToDelayed(outcome.untilMs, token);
    throw new DelayedError();
  }
}

import { UI_PROFILE_LEARN_QUEUE } from '@nautelle/shared';
import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type Job, Worker } from 'bullmq';
import { type LearnJobData, UiProfileLearnQueue } from './learn-queue';
import { type LearnOutcome, UiProfileLearner } from './ui-profile-learner';

/** Jobs one instance runs at once; each waits on one short model call. */
const CONCURRENCY = 2;
const CLOSE_TIMEOUT_MS = 10_000;
const ERROR_LOG_INTERVAL_MS = 60_000;

/**
 * Runs the `ui-profile-learn` queue on this instance (#752 A1), as the
 * `card-assess` worker does: created on bootstrap, not under `APP_ENV=test`
 * or `SCHEDULER_ENABLED=false` — e2e suites drive `process` themselves. A
 * learn is never retried: a failure is recorded on its run (A7).
 */
@Injectable()
export class UiProfileLearnWorker
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(UiProfileLearnWorker.name);
  private worker: Worker<LearnJobData> | undefined;

  constructor(
    private readonly learner: UiProfileLearner,
    private readonly queue: UiProfileLearnQueue,
    private readonly config: ConfigService,
  ) {}

  onApplicationBootstrap(): void {
    const enabled =
      this.config.get<string>('SCHEDULER_ENABLED') !== 'false' &&
      this.config.get<string>('APP_ENV') !== 'test';
    if (!enabled) return;
    if (!this.queue.queue) {
      this.logger.log(
        'no REDIS_URL: UI profiles do not learn from approvals on this instance',
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
      this.logger.warn(
        'ui-profile-learn worker did not close in time; forcing',
      );
      await worker.close(true);
    } finally {
      clearTimeout(timer);
    }
  }

  start(): Worker<LearnJobData> {
    const queue = this.queue.queue;
    if (!queue) throw new Error('ui-profile-learn queue is not registered');
    const worker = new Worker<LearnJobData>(
      UI_PROFILE_LEARN_QUEUE,
      (job) => this.process(job),
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
      this.logger.warn(`ui-profile-learn worker: ${error.message}`);
    });
    worker.on('failed', (job, error) => {
      this.logger.error(
        `ui-profile-learn job ${job?.id ?? '?'} failed: ${error.message}`,
      );
    });
    this.worker = worker;
    return worker;
  }

  process(job: Job<LearnJobData>): Promise<LearnOutcome> {
    return this.learner.process(job.data);
  }
}

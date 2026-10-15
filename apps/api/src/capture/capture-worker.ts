import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DelayedError, type Job, Worker } from 'bullmq';
import { CaptureService, type ExtractOutcome } from './capture.service';
import {
  CAPTURE_QUEUE,
  type CaptureJobData,
  CaptureQueue,
} from './capture-queue';

/** Extractions one instance starts at once; each only sends a command. */
const CONCURRENCY = 2;
const CLOSE_TIMEOUT_MS = 10_000;
const ERROR_LOG_INTERVAL_MS = 60_000;

/**
 * Runs the `card-capture` queue on this instance (issue #244 D2, D7). Like
 * the schedules worker it is created on bootstrap, not with `@Processor`,
 * and not under `APP_ENV=test` or `SCHEDULER_ENABLED=false`: e2e suites drive
 * `process` themselves. A deferred extraction goes back to the delayed set
 * under its own id, so the session keeps one job.
 */
@Injectable()
export class CaptureWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(CaptureWorker.name);
  private worker: Worker<CaptureJobData> | undefined;

  constructor(
    private readonly capture: CaptureService,
    private readonly queue: CaptureQueue,
    private readonly config: ConfigService,
  ) {}

  onApplicationBootstrap(): void {
    const enabled =
      this.config.get<string>('SCHEDULER_ENABLED') !== 'false' &&
      this.config.get<string>('APP_ENV') !== 'test';
    if (!enabled) return;
    if (!this.queue.queue) {
      this.logger.log(
        'no REDIS_URL: card capture does not run on this instance',
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
      this.logger.warn('card-capture worker did not close in time; forcing');
      await worker.close(true);
    } finally {
      clearTimeout(timer);
    }
  }

  /** A worker on the `card-capture` queue; e2e tests may start their own. */
  start(): Worker<CaptureJobData> {
    const queue = this.queue.queue;
    if (!queue) throw new Error('card-capture queue is not registered');
    const worker = new Worker<CaptureJobData>(
      CAPTURE_QUEUE,
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
      this.logger.warn(`card-capture worker: ${error.message}`);
    });
    worker.on('failed', (job, error) => {
      this.logger.error(
        `card-capture job ${job?.id ?? '?'} failed: ${error.message}`,
      );
    });
    this.worker = worker;
    return worker;
  }

  /** One job: extract, and put a deferred one back in the delayed set. */
  async process(
    job: Job<CaptureJobData>,
    token?: string,
  ): Promise<ExtractOutcome> {
    const outcome = await this.capture.extract(job.data);
    if (outcome.kind !== 'deferred') return outcome;
    if (outcome.offlineSince !== undefined) {
      await job.updateData({ ...job.data, offlineSince: outcome.offlineSince });
    }
    await job.moveToDelayed(outcome.untilMs, token);
    throw new DelayedError();
  }
}

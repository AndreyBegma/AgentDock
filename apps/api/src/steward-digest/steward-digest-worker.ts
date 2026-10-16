import { InjectQueue } from '@nestjs/bullmq';
import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type Job, type Queue, Worker } from 'bullmq';
import {
  type DigestPass,
  StewardDigestService,
} from './steward-digest.service';

export const STEWARD_DIGEST_QUEUE = 'steward-digest';
/** The one repeatable job: look for digests that came due. */
export const STEWARD_DIGEST_TICK_JOB = 'tick';
export const STEWARD_DIGEST_SCHEDULER = 'steward-digest.tick';
/** A digest may be up to this late; a 15-minute away-off lookback sits well over it. */
export const STEWARD_DIGEST_TICK_MS = 60_000;

const STARTUP_RETRY_MS = [1_000, 5_000, 15_000, 30_000, 60_000];
const CLOSE_TIMEOUT_MS = 10_000;
const ERROR_LOG_INTERVAL_MS = 60_000;

export type StewardDigestQueue = Queue<Record<string, never>>;

/**
 * Runs the `steward-digest` queue on this instance (#447 D14, ADR-0015): one
 * job scheduler ticking every minute, whose job makes the daily digests that
 * came due and the "while you were away" digests. `upsertJobScheduler` is
 * idempotent across instances and each tick goes to one worker; the digest
 * itself is deduplicated in the database, so a repeated tick changes nothing.
 *
 * Created on bootstrap and not under `APP_ENV=test` or `SCHEDULER_ENABLED=false`
 * (the schedules worker's rule) — e2e suites call `process` themselves.
 */
@Injectable()
export class StewardDigestWorker
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(StewardDigestWorker.name);
  private worker: Worker | undefined;
  private retry: NodeJS.Timeout | undefined;
  private stopped = false;

  constructor(
    private readonly digests: StewardDigestService,
    private readonly config: ConfigService,
    @Optional()
    @InjectQueue(STEWARD_DIGEST_QUEUE)
    readonly queue?: StewardDigestQueue,
  ) {}

  onApplicationBootstrap(): void {
    const enabled =
      this.config.get<string>('SCHEDULER_ENABLED') !== 'false' &&
      this.config.get<string>('APP_ENV') !== 'test';
    if (!enabled) return;
    if (!this.queue) {
      this.logger.log('no REDIS_URL: digests are not made on this instance');
      return;
    }
    this.start();
    void this.register(0);
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.retry);
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
      this.logger.warn('steward-digest worker did not close in time; forcing');
      await worker.close(true);
    } finally {
      clearTimeout(timer);
    }
  }

  start(): Worker {
    const queue = this.required();
    const worker = new Worker(
      STEWARD_DIGEST_QUEUE,
      (job) => this.process(job),
      { connection: queue.opts.connection, prefix: queue.opts.prefix },
    );
    const logged = new Map<string, number>();
    worker.on('error', (error) => {
      const last = logged.get(error.message) ?? 0;
      if (Date.now() - last < ERROR_LOG_INTERVAL_MS) return;
      logged.set(error.message, Date.now());
      this.logger.warn(`steward-digest worker: ${error.message}`);
    });
    worker.on('failed', (job, error) => {
      this.logger.error(
        `steward-digest job ${job?.id ?? '?'} failed: ${error.message}`,
      );
    });
    this.worker = worker;
    return worker;
  }

  /** Registers the tick scheduler; retried in the background until Redis answers. */
  async register(attempt = 0): Promise<void> {
    if (this.stopped) return;
    try {
      await this.required().upsertJobScheduler(
        STEWARD_DIGEST_SCHEDULER,
        { every: STEWARD_DIGEST_TICK_MS },
        {
          name: STEWARD_DIGEST_TICK_JOB,
          data: {},
          opts: { removeOnComplete: true, removeOnFail: { age: 86_400 } },
        },
      );
    } catch (error) {
      const delay =
        STARTUP_RETRY_MS[Math.min(attempt, STARTUP_RETRY_MS.length - 1)];
      this.logger.warn(
        `steward-digest start-up failed (${
          error instanceof Error ? error.message : String(error)
        }); retrying in ${delay} ms`,
      );
      this.retry = setTimeout(() => {
        void this.register(attempt + 1);
      }, delay);
      this.retry.unref();
    }
  }

  async process(job: Pick<Job, 'name'>): Promise<DigestPass | undefined> {
    if (job.name !== STEWARD_DIGEST_TICK_JOB) {
      this.logger.warn(`steward-digest: unknown job ${job.name}`);
      return undefined;
    }
    return this.digests.tick();
  }

  private required(): StewardDigestQueue {
    if (!this.queue)
      throw new Error('the steward-digest queue is not registered');
    return this.queue;
  }
}

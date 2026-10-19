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
import { type AiDigestPass, AiDigestService } from './ai-digest.service';

export const AI_DIGEST_QUEUE = 'ai-digest';
/** The one repeatable job: look for digests that came due. */
export const AI_DIGEST_TICK_JOB = 'tick';
export const AI_DIGEST_SCHEDULER = 'ai-digest.tick';
/** A digest may be up to this late. */
export const AI_DIGEST_TICK_MS = 60_000;

const STARTUP_RETRY_MS = [1_000, 5_000, 15_000, 30_000, 60_000];
const CLOSE_TIMEOUT_MS = 10_000;
const ERROR_LOG_INTERVAL_MS = 60_000;

export type AiDigestQueue = Queue<Record<string, never>>;

/**
 * Runs the `ai-digest` queue on this instance (#658, ADR-0015): one job
 * scheduler ticking every minute, whose job makes the daily AI digests that
 * came due. `upsertJobScheduler` is idempotent across instances and each tick
 * goes to one worker; an occurrence is claimed in the database, so a repeated
 * tick changes nothing.
 *
 * Created on bootstrap and not under `APP_ENV=test` or `SCHEDULER_ENABLED=false`
 * (the schedules worker's rule) — e2e suites call `process` themselves.
 */
@Injectable()
export class AiDigestWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(AiDigestWorker.name);
  private worker: Worker | undefined;
  private retry: NodeJS.Timeout | undefined;
  private stopped = false;

  constructor(
    private readonly digests: AiDigestService,
    private readonly config: ConfigService,
    @Optional()
    @InjectQueue(AI_DIGEST_QUEUE)
    readonly queue?: AiDigestQueue,
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
      this.logger.warn('ai-digest worker did not close in time; forcing');
      await worker.close(true);
    } finally {
      clearTimeout(timer);
    }
  }

  start(): Worker {
    const queue = this.required();
    const worker = new Worker(AI_DIGEST_QUEUE, (job) => this.process(job), {
      connection: queue.opts.connection,
      prefix: queue.opts.prefix,
    });
    const logged = new Map<string, number>();
    worker.on('error', (error) => {
      const last = logged.get(error.message) ?? 0;
      if (Date.now() - last < ERROR_LOG_INTERVAL_MS) return;
      logged.set(error.message, Date.now());
      this.logger.warn(`ai-digest worker: ${error.message}`);
    });
    worker.on('failed', (job, error) => {
      this.logger.error(
        `ai-digest job ${job?.id ?? '?'} failed: ${error.message}`,
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
        AI_DIGEST_SCHEDULER,
        { every: AI_DIGEST_TICK_MS },
        {
          name: AI_DIGEST_TICK_JOB,
          data: {},
          opts: { removeOnComplete: true, removeOnFail: { age: 86_400 } },
        },
      );
    } catch (error) {
      const delay =
        STARTUP_RETRY_MS[Math.min(attempt, STARTUP_RETRY_MS.length - 1)];
      this.logger.warn(
        `ai-digest start-up failed (${
          error instanceof Error ? error.message : String(error)
        }); retrying in ${delay} ms`,
      );
      this.retry = setTimeout(() => {
        void this.register(attempt + 1);
      }, delay);
      this.retry.unref();
    }
  }

  async process(job: Pick<Job, 'name'>): Promise<AiDigestPass | undefined> {
    if (job.name !== AI_DIGEST_TICK_JOB) {
      this.logger.warn(`ai-digest: unknown job ${job.name}`);
      return undefined;
    }
    return this.digests.tick();
  }

  private required(): AiDigestQueue {
    if (!this.queue) throw new Error('the ai-digest queue is not registered');
    return this.queue;
  }
}

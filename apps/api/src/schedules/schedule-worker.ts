import { InjectQueue } from '@nestjs/bullmq';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import { type Job, Worker } from 'bullmq';
import { ScheduleFireProcessor } from './schedule-fire.processor';
import { ScheduleMaintenance } from './schedule-maintenance';
import { ScheduleReconciler } from './schedule-reconciler';
import {
  FIRE_JOB,
  type FireJobData,
  type MaintenanceJobData,
  RECONCILE_JOB,
  SCHEDULES_QUEUE,
  type SchedulesQueue,
  SETTLE_JOB,
  within,
} from './schedule-timers';
import { SCHEDULER_OPTIONS, type SchedulerOptions } from './scheduler-options';

/** B10: the two job schedulers, as `/admin/system-jobs` lists them (B20). */
export const SETTLE_SCHEDULER = 'schedules.settle';
export const RECONCILE_SCHEDULER = 'schedules.reconcile';

/** Retry of the bootstrap registration while Redis is down (B18). */
const STARTUP_RETRY_MS = [1_000, 5_000, 15_000, 30_000, 60_000];

/** How long shutdown waits for running jobs before it forces the worker closed. */
const CLOSE_TIMEOUT_MS = 10_000;

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Runs the `schedules` queue on this instance (spec 123 B10, B11, B18): a
 * worker for `fire`, `settle` and `reconcile` jobs, the two job schedulers,
 * and one reconcile on boot. There is no leader: every instance with the
 * scheduler enabled runs a worker, and BullMQ hands each job to one of them.
 *
 * The worker is created here rather than with `@Processor`, which would
 * connect at init on every instance — under `APP_ENV=test` and without
 * `REDIS_URL` too (B19). Boot never waits on Redis: registration and the
 * first reconcile retry in the background until Redis answers.
 */
@Injectable()
export class ScheduleWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(ScheduleWorker.name);
  private readonly workers: Worker[] = [];
  private stopped = false;
  private retry: NodeJS.Timeout | undefined;

  constructor(
    private readonly processor: ScheduleFireProcessor,
    private readonly maintenance: ScheduleMaintenance,
    private readonly reconciler: ScheduleReconciler,
    @Inject(SCHEDULER_OPTIONS) private readonly options: SchedulerOptions,
    @Optional()
    @InjectQueue(SCHEDULES_QUEUE)
    private readonly queue?: SchedulesQueue,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.options.enabled) return;
    if (!this.queue) {
      this.logger.log('no REDIS_URL: schedules do not fire on this instance');
      return;
    }
    this.startWorker();
    void this.startMaintenance(0);
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.retry);
    await Promise.all(
      this.workers.map(async (worker) => {
        // A graceful close lets running jobs finish, but never returns while
        // Redis is unreachable; then shutdown forces it (the jobs' locks
        // expire and BullMQ hands them to another worker; B2 absorbs that).
        try {
          await within(worker.close(), CLOSE_TIMEOUT_MS);
        } catch {
          this.logger.warn('schedules worker did not close in time; forcing');
          await worker.close(true);
        }
      }),
    );
  }

  /** A worker on the `schedules` queue; e2e tests start their own. */
  startWorker(): Worker {
    const queue = this.required();
    const worker = new Worker<FireJobData | MaintenanceJobData>(
      SCHEDULES_QUEUE,
      (job, token) => this.dispatch(job, token),
      {
        connection: queue.opts.connection,
        prefix: queue.opts.prefix,
        concurrency: this.options.concurrency,
      },
    );
    worker.on('error', (error) => {
      this.logger.warn(`schedules worker: ${error.message}`);
    });
    worker.on('failed', (job, error) => {
      this.logger.error(
        `schedules job ${job?.id ?? '?'} failed: ${error.message}`,
      );
    });
    this.workers.push(worker);
    return worker;
  }

  /**
   * B10: `settle` every 15 s and `reconcile` every 60 s. `upsertJobScheduler`
   * is idempotent across instances, and each repetition goes to one worker.
   */
  async registerJobSchedulers(): Promise<void> {
    const queue = this.required();
    const opts = { removeOnComplete: true, removeOnFail: { age: 86_400 } };
    await queue.upsertJobScheduler(
      SETTLE_SCHEDULER,
      { every: this.options.settleMs },
      { name: SETTLE_JOB, data: {}, opts },
    );
    await queue.upsertJobScheduler(
      RECONCILE_SCHEDULER,
      { every: this.options.reconcileMs },
      { name: RECONCILE_JOB, data: {}, opts },
    );
  }

  /** B9, B10: registers the job schedulers and reconciles once; retried until Redis answers. */
  private async startMaintenance(attempt: number): Promise<void> {
    if (this.stopped) return;
    try {
      await this.registerJobSchedulers();
      await this.reconciler.reconcile();
    } catch (error) {
      const delay =
        STARTUP_RETRY_MS[Math.min(attempt, STARTUP_RETRY_MS.length - 1)];
      this.logger.warn(
        `schedules start-up failed (${message(error)}); retrying in ${delay} ms`,
      );
      this.retry = setTimeout(() => {
        void this.startMaintenance(attempt + 1);
      }, delay);
      this.retry.unref();
    }
  }

  private async dispatch(
    job: Job<FireJobData | MaintenanceJobData>,
    token: string | undefined,
  ): Promise<void> {
    switch (job.name) {
      case FIRE_JOB:
        return this.processor.process(job as Job<FireJobData>, token);
      case SETTLE_JOB:
        return this.maintenance.settle();
      case RECONCILE_JOB:
        await this.reconciler.reconcile();
        return;
      default:
        this.logger.warn(`schedules: unknown job ${job.name}`);
    }
  }

  private required(): SchedulesQueue {
    if (!this.queue) throw new Error('the schedules queue is not registered');
    return this.queue;
  }
}

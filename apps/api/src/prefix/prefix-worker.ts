import { PREFIX_PROPOSE_QUEUE, RULES_COMPRESS_QUEUE } from '@nautelle/shared';
import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type Queue, Worker } from 'bullmq';
import { PrefixProposer } from './prefix-proposer';
import type { CompressJobData, ProposeJobData } from './prefix-queues';
import { PrefixQueues } from './prefix-queues';
import type { PrefixJobOutcome } from './prefix-runs';
import { RulesCompressor } from './rules-compressor';

/** Jobs one instance runs at once per queue; each waits on one model call. */
const CONCURRENCY = 2;
const CLOSE_TIMEOUT_MS = 10_000;
const ERROR_LOG_INTERVAL_MS = 60_000;

/**
 * Runs the `rules-compress` and `prefix-propose` queues on this instance
 * (#751 B6, B8), as the `ui-profile-learn` worker does: created on bootstrap,
 * not under `APP_ENV=test` or `SCHEDULER_ENABLED=false` — e2e suites drive
 * `process` themselves. A job is never retried: a failure is on its run.
 */
@Injectable()
export class PrefixWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(PrefixWorker.name);
  private readonly workers: Worker[] = [];

  constructor(
    private readonly queues: PrefixQueues,
    private readonly compressor: RulesCompressor,
    private readonly proposer: PrefixProposer,
    private readonly config: ConfigService,
  ) {}

  onApplicationBootstrap(): void {
    const enabled =
      this.config.get<string>('SCHEDULER_ENABLED') !== 'false' &&
      this.config.get<string>('APP_ENV') !== 'test';
    if (!enabled) return;
    if (!this.queues.compress || !this.queues.propose) {
      this.logger.log(
        'no REDIS_URL: rules are not compressed and no prefix overlay is proposed on this instance',
      );
      return;
    }
    this.workers.push(
      this.start<CompressJobData>(
        RULES_COMPRESS_QUEUE,
        this.queues.compress,
        (d) => this.compressor.process(d),
      ),
      this.start<ProposeJobData>(
        PREFIX_PROPOSE_QUEUE,
        this.queues.propose,
        (d) => this.proposer.process(d),
      ),
    );
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all(this.workers.map((w) => this.close(w)));
  }

  private start<T>(
    name: string,
    queue: Queue<T>,
    process: (data: T) => Promise<PrefixJobOutcome>,
  ): Worker<T> {
    const worker = new Worker<T>(name, (job) => process(job.data), {
      connection: queue.opts.connection,
      prefix: queue.opts.prefix,
      concurrency: CONCURRENCY,
    });
    const logged = new Map<string, number>();
    worker.on('error', (error) => {
      const last = logged.get(error.message) ?? 0;
      if (Date.now() - last < ERROR_LOG_INTERVAL_MS) return;
      logged.set(error.message, Date.now());
      this.logger.warn(`${name} worker: ${error.message}`);
    });
    worker.on('failed', (job, error) => {
      this.logger.error(
        `${name} job ${job?.id ?? '?'} failed: ${error.message}`,
      );
    });
    return worker;
  }

  private async close(worker: Worker): Promise<void> {
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
      this.logger.warn(`${worker.name} worker did not close in time; forcing`);
      await worker.close(true);
    } finally {
      clearTimeout(timer);
    }
  }
}

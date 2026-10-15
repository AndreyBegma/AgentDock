import { captureJobId } from '@agentdock/shared';
import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, Optional } from '@nestjs/common';
import type { JobsOptions, Queue } from 'bullmq';

/** The `card-capture` queue (issue #244 "Jobs", ADR-0015). */
export const CAPTURE_QUEUE = 'card-capture';
export const EXTRACT_JOB = 'extract';

export interface CaptureJobData {
  /** `sessions.id` of the manual session. */
  sessionId: string;
  /** D7: a retry of this failed extraction, on the same content. */
  retryOf?: string;
  /** D7: when the runner was first found offline for this job (epoch ms). */
  offlineSince?: number;
}

export type CaptureQueueHandle = Queue<CaptureJobData>;

export const CAPTURE_JOB_OPTIONS: JobsOptions = {
  removeOnComplete: true,
  removeOnFail: { age: 86_400 },
};

/**
 * The ids a session's extraction can hold: the job itself, and one follow-up
 * for a hook that arrives while the job runs — its content came after what
 * the running job reads.
 */
export const captureJobIds = (sessionId: string): [string, string] => [
  captureJobId(sessionId),
  `${captureJobId(sessionId)}-next`,
];

/** The job id of a retry (D7). */
export const captureRetryJobId = (captureId: string): string =>
  `capture-retry-${captureId}`;

/**
 * D2: schedules a session's delayed extraction — one per session, debounced:
 * each call moves the pending job to `delayMs` from now. Without a
 * `REDIS_URL` there is no queue and nothing is scheduled.
 */
@Injectable()
export class CaptureQueue {
  private readonly logger = new Logger(CaptureQueue.name);

  constructor(
    @Optional()
    @InjectQueue(CAPTURE_QUEUE)
    readonly queue?: CaptureQueueHandle,
  ) {}

  get enabled(): boolean {
    return this.queue !== undefined;
  }

  async schedule(sessionId: string, delayMs: number): Promise<void> {
    const queue = this.queue;
    if (!queue) return;
    for (const id of captureJobIds(sessionId)) {
      const job = await queue.getJob(id);
      if (!job) {
        await queue.add(
          EXTRACT_JOB,
          { sessionId },
          { ...CAPTURE_JOB_OPTIONS, jobId: id, delay: delayMs },
        );
        return;
      }
      const state = await job.getState();
      if (state === 'delayed') {
        await job.changeDelay(delayMs);
        return;
      }
      if (state === 'completed' || state === 'failed') {
        await job.remove();
        await queue.add(
          EXTRACT_JOB,
          { sessionId },
          { ...CAPTURE_JOB_OPTIONS, jobId: id, delay: delayMs },
        );
        return;
      }
      // Waiting: it runs now and reads everything so far. Active: the next id.
      if (state !== 'active') return;
    }
    this.logger.debug(`session ${sessionId}: an extraction is already queued`);
  }

  /** D7: a failed extraction runs once more, on the same content. */
  async retry(sessionId: string, captureId: string): Promise<void> {
    await this.queue?.add(
      EXTRACT_JOB,
      { sessionId, retryOf: captureId },
      { ...CAPTURE_JOB_OPTIONS, jobId: captureRetryJobId(captureId) },
    );
  }
}

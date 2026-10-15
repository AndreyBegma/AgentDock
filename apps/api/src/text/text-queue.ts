import { TEXT_NORMALIZE_QUEUE, textNormalizeJobId } from '@agentdock/shared';
import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Optional } from '@nestjs/common';
import type { JobsOptions, Queue } from 'bullmq';

export const NORMALIZE_JOB = 'normalize';

export interface TextJobData {
  /** `text_normalizations.id`. */
  normalizationId: string;
  /** D11: how many times the runner was found offline so far. */
  offlineAttempts?: number;
  /** D11: when the runner was first found offline for this job (epoch ms). */
  offlineSince?: number;
}

export type TextQueueHandle = Queue<TextJobData>;

const JOB_OPTIONS: JobsOptions = {
  removeOnComplete: true,
  removeOnFail: { age: 86_400 },
};

/**
 * The `text-normalize` queue (issue #271 D3, ADR-0015): one job per request.
 * Without a `REDIS_URL` there is no queue and a request stays `pending`.
 */
@Injectable()
export class TextQueue {
  constructor(
    @Optional()
    @InjectQueue(TEXT_NORMALIZE_QUEUE)
    readonly queue?: TextQueueHandle,
  ) {}

  get enabled(): boolean {
    return this.queue !== undefined;
  }

  /**
   * Queues the request, `delayMs` from now. A finished job of the same
   * request (a retry) is replaced; a waiting or running one is kept.
   */
  async add(normalizationId: string, delayMs = 0): Promise<void> {
    const queue = this.queue;
    if (!queue) return;
    const jobId = textNormalizeJobId(normalizationId);
    const job = await queue.getJob(jobId);
    if (job) {
      const state = await job.getState();
      if (state !== 'completed' && state !== 'failed') return;
      await job.remove();
    }
    await queue.add(
      NORMALIZE_JOB,
      { normalizationId },
      { ...JOB_OPTIONS, jobId, delay: delayMs },
    );
  }
}

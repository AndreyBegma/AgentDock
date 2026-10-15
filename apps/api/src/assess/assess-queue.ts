import { CARD_ASSESS_QUEUE, cardAssessJobId } from '@agentdock/shared';
import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Optional } from '@nestjs/common';
import type { JobsOptions, Queue } from 'bullmq';

export const ASSESS_JOB = 'assess';

export interface AssessJobData {
  cardId: string;
  /** The input hash the job was queued for (D6). */
  hash: string;
}

export type AssessQueueHandle = Queue<AssessJobData>;

const JOB_OPTIONS: JobsOptions = {
  removeOnComplete: true,
  removeOnFail: { age: 86_400 },
};

/**
 * The `card-assess` queue (issue #322 D6, ADR-0015): one job per card and
 * input hash. Without a `REDIS_URL` there is no queue and no card is
 * assessed.
 */
@Injectable()
export class AssessQueue {
  constructor(
    @Optional()
    @InjectQueue(CARD_ASSESS_QUEUE)
    readonly queue?: AssessQueueHandle,
  ) {}

  get enabled(): boolean {
    return this.queue !== undefined;
  }

  /**
   * Queues the card's assessment of `hash`. A waiting or running job of the
   * same input is kept; a finished one is replaced.
   */
  async add(cardId: string, hash: string): Promise<void> {
    const queue = this.queue;
    if (!queue) return;
    const jobId = cardAssessJobId(cardId, hash);
    const job = await queue.getJob(jobId);
    if (job) {
      const state = await job.getState();
      if (state !== 'completed' && state !== 'failed') return;
      await job.remove();
    }
    await queue.add(ASSESS_JOB, { cardId, hash }, { ...JOB_OPTIONS, jobId });
  }
}

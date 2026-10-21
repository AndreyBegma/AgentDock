import { UI_PROFILE_LEARN_QUEUE, uiProfileLearnJobId } from '@nautelle/shared';
import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Optional } from '@nestjs/common';
import type { JobsOptions, Queue } from 'bullmq';

export const LEARN_JOB = 'learn';

export interface LearnJobData {
  designId: string;
  /** The approved revision the job learns from (#752 A1). */
  revisionId: string;
}

export type LearnQueueHandle = Queue<LearnJobData>;

const JOB_OPTIONS: JobsOptions = {
  removeOnComplete: { age: 86_400 },
  removeOnFail: { age: 86_400 },
};

/**
 * The `ui-profile-learn` queue (#752 A1, ADR-0015): one job per approved
 * revision. Without a `REDIS_URL` there is no queue and nothing is learned;
 * the approval is unaffected.
 */
@Injectable()
export class UiProfileLearnQueue {
  constructor(
    @Optional()
    @InjectQueue(UI_PROFILE_LEARN_QUEUE)
    readonly queue?: LearnQueueHandle,
  ) {}

  get enabled(): boolean {
    return this.queue !== undefined;
  }

  /**
   * Queues the learn of `revisionId`. The job id is the revision's, so an
   * approval enqueues exactly one learn: a second add of the same revision —
   * waiting, running or finished within a day — is a no-op in BullMQ.
   */
  async add(designId: string, revisionId: string): Promise<void> {
    await this.queue?.add(
      LEARN_JOB,
      { designId, revisionId },
      { ...JOB_OPTIONS, jobId: uiProfileLearnJobId(revisionId) },
    );
  }
}

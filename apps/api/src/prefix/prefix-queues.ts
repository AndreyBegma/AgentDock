import {
  type FileOverlayPart,
  PREFIX_PROPOSE_QUEUE,
  RULES_COMPRESS_DEBOUNCE_MS,
  RULES_COMPRESS_QUEUE,
} from '@nautelle/shared';
import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Optional } from '@nestjs/common';
import type { JobsOptions, Queue } from 'bullmq';

export const COMPRESS_JOB = 'compress';
export const PROPOSE_JOB = 'propose';

export interface CompressJobData {
  projectId: string;
  /** The rules version at the request; a job of an older one does nothing. */
  rulesVersion: string;
  /** Who changed the rules, for the run's `triggeredById`. */
  userId: string | null;
}

export interface ProposeJobData {
  projectId: string;
  part: FileOverlayPart;
  userId: string | null;
}

const JOB_OPTIONS: JobsOptions = {
  removeOnComplete: { age: 86_400 },
  removeOnFail: { age: 86_400 },
};

/** BullMQ job ids may not contain `:`. */
const jobKey = (...parts: string[]): string =>
  parts.map((p) => p.replace(/[^A-Za-z0-9_-]/g, '_')).join('-');

/**
 * The prefix's two queues (#751 B6, B8, ADR-0015). Without a `REDIS_URL`
 * there are none: nothing is compressed or proposed, launches use the
 * originals.
 */
@Injectable()
export class PrefixQueues {
  constructor(
    @Optional()
    @InjectQueue(RULES_COMPRESS_QUEUE)
    readonly compress?: Queue<CompressJobData>,
    @Optional()
    @InjectQueue(PREFIX_PROPOSE_QUEUE)
    readonly propose?: Queue<ProposeJobData>,
  ) {}

  /**
   * B6: one job per `(project, rules version)`, delayed by the debounce — a
   * burst of edits leaves only its last version current, and every older
   * job finds its version gone and does nothing.
   */
  async addCompress(data: CompressJobData): Promise<void> {
    await this.compress?.add(COMPRESS_JOB, data, {
      ...JOB_OPTIONS,
      delay: RULES_COMPRESS_DEBOUNCE_MS,
      jobId: jobKey('rules', data.projectId, data.rulesVersion),
    });
  }

  /**
   * B8: the one-open-proposal-per-part rule is checked when the job runs. An
   * automatic proposal (QB2) has one job id per part, so the launches that
   * find the kind over budget queue it once a day, not once each.
   */
  async addPropose(data: ProposeJobData, auto = false): Promise<void> {
    await this.propose?.add(PROPOSE_JOB, data, {
      ...JOB_OPTIONS,
      jobId: auto
        ? jobKey('auto', data.projectId, data.part)
        : jobKey('propose', data.projectId, data.part, String(Date.now())),
    });
  }
}

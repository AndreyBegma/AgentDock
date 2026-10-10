import type { CollectorPollArgs } from '@agentdock/shared/protocol';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { SYSTEM_ACTOR } from '../audit/audit.types';
import { RunnerCommandService } from '../runners/runner-command.service';

/** How one `collector.poll` ended. */
export type CollectorPollOutcome = 'sent' | 'failed' | 'unwired';

/**
 * The one place the GitHub module sends `collector.poll` (spec 27 D13), as the
 * system actor: the command is `admin`-only in the allowlist and no user route
 * reaches this class. A runner that is offline or does not answer is `failed`;
 * nothing retries, and the runner's own interval stays the fallback.
 */
@Injectable()
export class CollectorPollSender {
  private readonly logger = new Logger(CollectorPollSender.name);

  // Property injection, not a constructor argument: the e2e helper that
  // stands in for this class (`RecordingPollSender`) is built with `new` and
  // never sends.
  @Inject(RunnerCommandService)
  private readonly commands!: RunnerCommandService;

  async send(
    runnerId: string,
    args: CollectorPollArgs,
  ): Promise<CollectorPollOutcome> {
    try {
      const result = await this.commands.send(
        runnerId,
        'collector.poll',
        args,
        { role: 'admin', ctx: { actor: SYSTEM_ACTOR } },
      );
      if (result.status === 'ok') return 'sent';
      this.logger.debug(
        `collector.poll for project ${args.projectId} on runner ${runnerId}: ${result.status}`,
      );
    } catch (error) {
      this.logger.warn(
        `collector.poll for project ${args.projectId} on runner ${runnerId} failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return 'failed';
  }
}

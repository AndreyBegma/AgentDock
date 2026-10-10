import type { CollectorPollArgs } from '@agentdock/shared/protocol';
import { Injectable, Logger } from '@nestjs/common';

/** How one `collector.poll` ended. */
export type CollectorPollOutcome = 'sent' | 'failed' | 'unwired';

/**
 * The one place the GitHub module sends `collector.poll` (spec 27 D13).
 *
 * The command is defined in `packages/shared/src/protocol/commands/github.ts`
 * but not yet entered in the `commands` allowlist: the runner's
 * `CommandHandlers` needs a handler for every entry, and the handler comes
 * with the runner slot of #27. Until then a poll is `unwired` and the runner
 * keeps its 60 s cadence. That slot adds the entry and replaces this body with
 * `this.commands.send(runnerId, 'collector.poll', args, { role: 'admin', ctx: { actor: SYSTEM_ACTOR } })`
 * on an injected `RunnerCommandService`, mapping `ok` → `sent`, else `failed`.
 */
@Injectable()
export class CollectorPollSender {
  private readonly logger = new Logger(CollectorPollSender.name);

  async send(
    runnerId: string,
    args: CollectorPollArgs,
  ): Promise<CollectorPollOutcome> {
    this.logger.debug(
      `collector.poll for project ${args.projectId} on runner ${runnerId} not sent: the runner handler is not wired yet`,
    );
    return 'unwired';
  }
}

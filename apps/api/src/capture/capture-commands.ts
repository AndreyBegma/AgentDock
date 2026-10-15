import type { CardsExtractArgs } from '@agentdock/shared/protocol';
import { Injectable } from '@nestjs/common';
import { SYSTEM_ACTOR } from '../audit/audit.types';
import { RunnerCommandService } from '../runners/runner-command.service';
import { RunnerPresence } from '../runners/runner-presence';

/** How sending `cards.extract` ended. */
export type ExtractSendResult =
  | { status: 'ok' }
  | { status: 'error'; message: string }
  /** No answer in time: the runner may have started it; its event settles it. */
  | { status: 'unknown' };

/**
 * The one place capture talks to the runner (issue #244 D4). While the
 * runner is offline or does not advertise `cards.extract` the command is not
 * `ready` and the extraction waits (D7 backoff). Sending goes through
 * `RunnerCommandService` — role check, `runner.command` audit, timeout — as
 * the system, with the prompt out of the audit record.
 */
@Injectable()
export class CaptureCommands {
  constructor(
    private readonly commands: RunnerCommandService,
    private readonly presence: RunnerPresence,
  ) {}

  /** Whether `cards.extract` can be sent to `runnerId` now. */
  ready(runnerId: string): boolean {
    return (
      this.presence.isConnected(runnerId) &&
      this.presence.missingCommand(runnerId, ['cards.extract']) === null
    );
  }

  async extract(
    runnerId: string,
    args: CardsExtractArgs,
  ): Promise<ExtractSendResult> {
    const result = await this.commands.send(runnerId, 'cards.extract', args, {
      role: 'operator',
      ctx: { actor: SYSTEM_ACTOR },
      // The prompt is session content: never verbatim in the audit log.
      auditArgs: { ...args, prompt: `[${args.prompt.length} chars]` },
    });
    switch (result.status) {
      case 'ok':
        return { status: 'ok' };
      case 'unknown':
        return result;
      case 'error':
        return {
          status: 'error',
          message: `${result.error.code}${result.error.message ? ` — ${result.error.message}` : ''}`,
        };
    }
  }
}

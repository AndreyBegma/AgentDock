import type { TextNormalizeArgs } from '@agentdock/shared/protocol';
import { Injectable } from '@nestjs/common';
import { SYSTEM_ACTOR } from '../audit/audit.types';
import { RunnerCommandService } from '../runners/runner-command.service';
import { RunnerPresence } from '../runners/runner-presence';

/** Whether `text.normalize` can go to a runner now (D11). */
export type TextRunnerState = 'ready' | 'offline' | 'unsupported';

/** How sending `text.normalize` ended. */
export type NormalizeSendResult =
  | { status: 'ok' }
  | { status: 'error'; message: string }
  /** No answer in time: the runner may have started it; its event settles it. */
  | { status: 'unknown' };

/**
 * The one place text normalization talks to the runner (issue #271 D4,
 * D11). A runner that is connected but does not advertise `text.normalize`
 * is `unsupported` at once (ADR-0023); one that is not connected waits. The
 * prompt is the person's text: never verbatim in the audit log.
 */
@Injectable()
export class TextCommands {
  constructor(
    private readonly commands: RunnerCommandService,
    private readonly presence: RunnerPresence,
  ) {}

  state(runnerId: string): TextRunnerState {
    if (!this.presence.isConnected(runnerId)) return 'offline';
    return this.presence.missingCommand(runnerId, ['text.normalize']) === null
      ? 'ready'
      : 'unsupported';
  }

  async normalize(
    runnerId: string,
    args: TextNormalizeArgs,
  ): Promise<NormalizeSendResult> {
    const result = await this.commands.send(runnerId, 'text.normalize', args, {
      role: 'operator',
      ctx: { actor: SYSTEM_ACTOR },
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

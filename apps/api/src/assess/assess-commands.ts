import type {
  AssessCommandName,
  CardAssessArgs,
  CommandName,
} from '@nautelle/shared/protocol';
import { isCommandName } from '@nautelle/shared/protocol';
import { Injectable } from '@nestjs/common';
import { SYSTEM_ACTOR } from '../audit/audit.types';
import { RunnerCommandService } from '../runners/runner-command.service';
import { RunnerPresence } from '../runners/runner-presence';

/** Whether `card.assess` can go to a runner now (D7). */
export type AssessRunnerState = 'ready' | 'offline' | 'unsupported';

/** How sending `card.assess` ended. */
export type AssessSendResult =
  | { status: 'ok' }
  | { status: 'error'; message: string }
  /** No answer in time: the runner may have started it; its event settles it. */
  | { status: 'unknown' };

const CARD_ASSESS: AssessCommandName = 'card.assess';

/**
 * `card.assess` as a `CommandName` once the allowlist carries it, else
 * `null`: the allowlist entry lands with the runner's handler (i322-runner),
 * so until then this API treats every runner as not serving it.
 */
const listedName = (): CommandName | null =>
  isCommandName(CARD_ASSESS) ? CARD_ASSESS : null;

/**
 * The one place the assessment talks to the runner (issue #322 D5, D7). A
 * runner that is connected but does not advertise `card.assess` is
 * `unsupported` (ADR-0023). The prompt is the card's text: never verbatim in
 * the audit log.
 */
@Injectable()
export class AssessCommands {
  constructor(
    private readonly commands: RunnerCommandService,
    private readonly presence: RunnerPresence,
  ) {}

  state(runnerId: string): AssessRunnerState {
    if (!this.presence.isConnected(runnerId)) return 'offline';
    const name = listedName();
    if (name === null) return 'unsupported';
    return this.presence.missingCommand(runnerId, [name]) === null
      ? 'ready'
      : 'unsupported';
  }

  async assess(
    runnerId: string,
    args: CardAssessArgs,
  ): Promise<AssessSendResult> {
    const name = listedName();
    if (name === null) {
      return { status: 'error', message: 'unknown_command — card.assess' };
    }
    const result = await this.commands.send(runnerId, name, args, {
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

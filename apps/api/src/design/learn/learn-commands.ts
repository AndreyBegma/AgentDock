import {
  type UiProfileLearnArgs,
  type UiProfileLearnResult,
  uiProfileLearnResultSchema,
} from '@nautelle/shared/protocol';
import { Injectable } from '@nestjs/common';
import type { AuditContext } from '../../audit/audit.types';
import { RunnerCommandService } from '../../runners/runner-command.service';
import { RunnerPresence } from '../../runners/runner-presence';

/** How sending `uiprofile.learn` ended. */
export type LearnSendResult =
  | { status: 'ok'; output: UiProfileLearnResult }
  | { status: 'error'; message: string }
  | { status: 'unknown' };

/**
 * The one place the learn talks to the runner (#752 A2), as `AssessCommands`
 * is for `card.assess`. Only a connected runner that advertises
 * `uiprofile.learn` is `ready` (ADR-0023); the prompt is a design's text,
 * never verbatim in the audit log.
 */
@Injectable()
export class UiProfileLearnCommands {
  constructor(
    private readonly commands: RunnerCommandService,
    private readonly presence: RunnerPresence,
  ) {}

  state(runnerId: string): 'ready' | 'offline' | 'unsupported' {
    if (!this.presence.isConnected(runnerId)) return 'offline';
    return this.presence.commandSupport(runnerId, 'uiprofile.learn') ===
      'supported'
      ? 'ready'
      : 'unsupported';
  }

  async learn(
    runnerId: string,
    args: UiProfileLearnArgs,
    ctx: AuditContext,
  ): Promise<LearnSendResult> {
    const result = await this.commands.send(runnerId, 'uiprofile.learn', args, {
      role: 'operator',
      ctx,
      auditArgs: { ...args, prompt: `<${args.prompt.length} chars>` },
    });
    switch (result.status) {
      case 'unknown':
        return result;
      case 'error':
        return {
          status: 'error',
          message: `${result.error.code}${result.error.message ? ` — ${result.error.message}` : ''}`,
        };
      case 'ok': {
        const output = uiProfileLearnResultSchema.safeParse(result.output);
        return output.success
          ? { status: 'ok', output: output.data }
          : { status: 'error', message: 'internal — malformed result' };
      }
    }
  }
}

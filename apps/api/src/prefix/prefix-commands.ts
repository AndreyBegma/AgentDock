import {
  type PrefixProposeArgs,
  type PrefixProposeResult,
  prefixProposeResultSchema,
  type RulesCompressArgs,
  type RulesCompressResult,
  rulesCompressResultSchema,
} from '@nautelle/shared/protocol';
import { Injectable } from '@nestjs/common';
import type { z } from 'zod';
import type { AuditContext } from '../audit/audit.types';
import { RunnerCommandService } from '../runners/runner-command.service';
import { RunnerPresence } from '../runners/runner-presence';

/** How sending a prefix command ended; `code` is the runner's error code. */
export type PrefixSendResult<T> =
  | { status: 'ok'; output: T }
  | { status: 'error'; code: string; message: string }
  | { status: 'unknown' };

export type PrefixCommandState = 'ready' | 'offline' | 'unsupported';

/**
 * The one place the prefix talks to the runner (#751 B6, B8), as
 * `UiProfileLearnCommands` is for `uiprofile.learn`. Only a connected runner
 * that advertises the command is `ready` (ADR-0023). Neither the prompt nor a
 * file's text goes into the audit log verbatim.
 */
@Injectable()
export class PrefixCommands {
  constructor(
    private readonly commands: RunnerCommandService,
    private readonly presence: RunnerPresence,
  ) {}

  state(
    runnerId: string,
    name: 'rules.compress' | 'prefix.propose',
  ): PrefixCommandState {
    if (!this.presence.isConnected(runnerId)) return 'offline';
    return this.presence.commandSupport(runnerId, name) === 'supported'
      ? 'ready'
      : 'unsupported';
  }

  async compress(
    runnerId: string,
    args: RulesCompressArgs,
    ctx: AuditContext,
  ): Promise<PrefixSendResult<RulesCompressResult>> {
    const result = await this.commands.send(runnerId, 'rules.compress', args, {
      role: 'operator',
      ctx,
      auditArgs: { ...args, prompt: `<${args.prompt.length} chars>` },
    });
    return settle(result, rulesCompressResultSchema);
  }

  async propose(
    runnerId: string,
    args: PrefixProposeArgs,
    ctx: AuditContext,
  ): Promise<PrefixSendResult<PrefixProposeResult>> {
    const result = await this.commands.send(runnerId, 'prefix.propose', args, {
      role: 'admin',
      ctx,
      auditArgs: { ...args, root: '<root>' },
    });
    return settle(result, prefixProposeResultSchema);
  }
}

type Sent =
  | { status: 'ok'; output: unknown }
  | { status: 'error'; error: { code: string; message?: string } }
  | { status: 'unknown' };

const settle = <S extends z.ZodType>(
  result: Sent,
  schema: S,
): PrefixSendResult<z.infer<S>> => {
  switch (result.status) {
    case 'unknown':
      return result;
    case 'error':
      return {
        status: 'error',
        code: result.error.code,
        message: `${result.error.code}${result.error.message ? ` — ${result.error.message}` : ''}`,
      };
    case 'ok': {
      const output = schema.safeParse(result.output);
      return output.success
        ? { status: 'ok', output: output.data }
        : {
            status: 'error',
            code: 'internal',
            message: 'internal — malformed result',
          };
    }
  }
};

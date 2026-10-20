import { DESIGN_ERROR } from '@nautelle/shared';
import {
  type CommandName,
  isCommandName,
  type UiProfileCommandName,
  uiprofileCommands,
} from '@nautelle/shared/protocol';
import { Injectable } from '@nestjs/common';
import type { z } from 'zod';
import type { PlannerSendResult } from '../planner/planner-commands';
import {
  RunnerCommandService,
  type SendOptions,
} from '../runners/runner-command.service';
import { RunnerPresence } from '../runners/runner-presence';
import { designError } from './design-error';

export type DesignCommandArgs<N extends UiProfileCommandName> = z.input<
  (typeof uiprofileCommands)[N]['args']
>;
export type DesignCommandOutput<N extends UiProfileCommandName> = z.infer<
  (typeof uiprofileCommands)[N]['result']
>;

/**
 * The one place the design stage sends runner commands
 * (docs/specs/223-design-stage.md "Protocol", D13).
 *
 * `uiprofileCommands` is defined in the protocol but entered in the
 * `commands` allowlist only with the runner's handlers (i223-runner). Until
 * then a profile command answers 503 `command_unavailable`, sending nothing;
 * once the allowlist holds it, it goes through `RunnerCommandService` — role
 * check, `runner.command` audit, timeout — with no change here. The planner's
 * `PlannerCommands` is the precedent.
 */
@Injectable()
export class DesignCommands {
  constructor(
    private readonly commands: RunnerCommandService,
    private readonly presence: RunnerPresence,
  ) {}

  /**
   * Throws 503 `command_unavailable` when `name` cannot be sent to `runnerId`
   * now, and 409 `runner_outdated` when the runner's hello says it does not
   * serve it (#233).
   */
  assertReady(runnerId: string, name: UiProfileCommandName): void {
    const wired: string = name;
    if (!isCommandName(wired)) {
      throw designError(
        503,
        DESIGN_ERROR.commandUnavailable,
        `${name} is not available on the runner yet`,
      );
    }
    if (!this.presence.isConnected(runnerId)) {
      throw designError(
        503,
        DESIGN_ERROR.commandUnavailable,
        'The runner is not connected',
      );
    }
    this.assertServed(runnerId, [wired]);
  }

  /**
   * Throws 409 `runner_outdated` when the runner's hello says it does not
   * serve one of `names` (#233). Unknown or disabled pass: the runner's own
   * answer stays authoritative.
   */
  assertServed(runnerId: string, names: readonly CommandName[]): void {
    const missing = this.presence.missingCommand(runnerId, names);
    if (missing) {
      throw designError(
        409,
        DESIGN_ERROR.runnerOutdated,
        `The runner does not serve ${missing}; update it`,
      );
    }
  }

  async send<N extends UiProfileCommandName>(
    runnerId: string,
    name: N,
    args: DesignCommandArgs<N>,
    options: SendOptions,
  ): Promise<PlannerSendResult<DesignCommandOutput<N>>> {
    this.assertReady(runnerId, name);
    const wired: string = name;
    if (!isCommandName(wired)) throw new Error('unreachable');
    const result = await this.commands.send(runnerId, wired, args, options);
    if (result.status !== 'ok') return result;
    const output = uiprofileCommands[name].result.safeParse(result.output);
    if (!output.success) {
      return {
        status: 'error',
        error: { code: 'internal', message: 'malformed result' },
      };
    }
    return { status: 'ok', output: output.data as DesignCommandOutput<N> };
  }
}

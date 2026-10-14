import type { RunnerStatus } from '@agentdock/shared';
import {
  type CommandName,
  type CommandSupport,
  commandSupport,
} from '@agentdock/shared/protocol';
import { Inject, Injectable } from '@nestjs/common';
import type { Runner } from '@prisma/client';
import { RunnerConnections } from './runner-connections';
import { RUNNER_OPTIONS, type RunnerOptions } from './runner-options';
import { deriveStatus } from './status';

/** Runner status for modules outside this one (spec 6 D5). */
@Injectable()
export class RunnerPresence {
  constructor(
    private readonly connections: RunnerConnections,
    @Inject(RUNNER_OPTIONS) private readonly options: RunnerOptions,
  ) {}

  status(runner: Pick<Runner, 'id' | 'revokedAt'>): RunnerStatus {
    return deriveStatus(
      {
        revokedAt: runner.revokedAt,
        lastBeatAt: this.connections.get(runner.id)?.lastBeatAt ?? null,
      },
      Date.now(),
      this.options.staleAfterMs,
    );
  }

  /** Whether the runner has an open socket a command can be sent on. */
  isConnected(runnerId: string): boolean {
    return this.connections.get(runnerId) !== undefined;
  }

  /**
   * Whether the connected runner serves `name`, from its latest hello (#233,
   * ADR-0023); `unknown` when it is not connected or advertised nothing.
   */
  commandSupport(runnerId: string, name: CommandName): CommandSupport {
    return commandSupport(this.connections.get(runnerId)?.commands, name);
  }

  /**
   * The first of `names` the runner says it does not serve, or null. Only
   * `missing` refuses: `disabled` and `unknown` are left to the runner's own
   * answer, which stays authoritative.
   */
  missingCommand(
    runnerId: string,
    names: readonly CommandName[],
  ): CommandName | null {
    return (
      names.find((name) => this.commandSupport(runnerId, name) === 'missing') ??
      null
    );
  }
}

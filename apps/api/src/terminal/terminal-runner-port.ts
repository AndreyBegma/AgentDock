import type {
  CommandErrorCode,
  TerminalAttachArgs,
  TerminalCloseMessage,
  TerminalDataMessage,
  TerminalResizeMessage,
} from '@agentdock/shared/protocol';
import { Injectable, Logger } from '@nestjs/common';
import type { AuditContext } from '../audit/audit.types';
import { RunnerCommandService } from '../runners/runner-command.service';
import { RunnerStreams } from '../runners/runner-streams';

/** How a `terminal.attach` ended — `RunnerCommandService.send`'s result, narrowed. */
export type TerminalAttachOutcome =
  | { status: 'ok'; session: string }
  | { status: 'error'; code: CommandErrorCode; message?: string }
  | { status: 'unknown' };

/** Server → runner messages of an open attach. */
export type TerminalToRunner =
  | TerminalDataMessage
  | TerminalResizeMessage
  | TerminalCloseMessage;
/** Runner → server messages of an open attach. */
export type TerminalFromRunner = TerminalDataMessage | TerminalCloseMessage;

/**
 * What the relay needs from the runner side: send the admin-only
 * `terminal.attach` command, and send stream messages on the runner's socket.
 * Runner → server messages arrive through `TerminalRelay.fromRunner`.
 */
export interface TerminalRunnerPort {
  attach(
    runnerId: string,
    args: TerminalAttachArgs,
    options: { ctx: AuditContext },
  ): Promise<TerminalAttachOutcome>;
  /** False when the runner is offline. */
  send(runnerId: string, message: TerminalToRunner): boolean;
}

export const TERMINAL_RUNNER_PORT = Symbol('TERMINAL_RUNNER_PORT');

/**
 * The runner side of the relay. `terminal.attach` goes through
 * `RunnerCommandService`, so it is checked against the allowlist's minimum
 * role and gets the usual `runner.command` records (args only, no bytes).
 * Stream messages go out on the runner's socket through `RunnerStreams`.
 */
@Injectable()
export class RunnerTerminalPort implements TerminalRunnerPort {
  private readonly logger = new Logger(RunnerTerminalPort.name);

  constructor(
    private readonly commands: RunnerCommandService,
    private readonly streams: RunnerStreams,
  ) {}

  async attach(
    runnerId: string,
    args: TerminalAttachArgs,
    { ctx }: { ctx: AuditContext },
  ): Promise<TerminalAttachOutcome> {
    try {
      // The gateway let only an admin this far (D1); the allowlist checks it again.
      const result = await this.commands.send(
        runnerId,
        'terminal.attach',
        args,
        { role: 'admin', ctx },
      );
      switch (result.status) {
        case 'ok':
          return { status: 'ok', session: result.output.session };
        case 'error':
          return { status: 'error', ...result.error };
        case 'unknown':
          return { status: 'unknown' };
      }
    } catch (error) {
      // Invalid args or role: refused before anything was sent.
      this.logger.warn(
        `terminal.attach on runner ${runnerId} refused: ${(error as Error).message}`,
      );
      return { status: 'error', code: 'invalid_args' };
    }
  }

  send(runnerId: string, message: TerminalToRunner): boolean {
    return this.streams.send(runnerId, message);
  }
}

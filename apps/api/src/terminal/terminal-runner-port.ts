import type {
  CommandErrorCode,
  TerminalAttachArgs,
  TerminalCloseMessage,
  TerminalDataMessage,
  TerminalResizeMessage,
} from '@agentdock/shared/protocol';
import { Injectable } from '@nestjs/common';
import type { AuditContext } from '../audit/audit.types';

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
 * The runner side of the relay, not wired yet (spec 29 notes).
 *
 * - `attach`: `terminal.attach` is exported as `terminalCommands` but enters
 *   the `commands` allowlist only with its runner handler (i29-runner). Until
 *   then it answers `unsupported`; afterwards the body is
 *   `RunnerCommandService.send(runnerId, 'terminal.attach', args, { role: 'admin', ctx })`
 *   mapped to `TerminalAttachOutcome`.
 * - `send`: `RunnerStreams.send` accepts `subscribe` / `unsubscribe` only;
 *   it gains the terminal messages in `runners/runner-streams.ts`, together
 *   with the gateway's `case 'terminal.data' | 'terminal.close'`.
 */
@Injectable()
export class RunnerTerminalPort implements TerminalRunnerPort {
  async attach(): Promise<TerminalAttachOutcome> {
    return {
      status: 'error',
      code: 'unsupported',
      message: 'terminal.attach is not available on the API yet',
    };
  }

  send(): boolean {
    return false;
  }
}

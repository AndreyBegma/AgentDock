import { Injectable } from '@nestjs/common';
import { BoardSessionRefusal } from '../board/board-session.service';
import {
  BoardTerminalService,
  type ManualSession,
  NotAManualSession,
} from '../board/board-terminal.service';
import { type LocalCall, projectOf } from './local-call';
import { LocalError } from './local-error';

export const notManual = () =>
  new LocalError(
    'not_a_manual_session',
    "not a person's own Claude Code session",
  );

/**
 * #845 §2 (ADR-0083): a control tool answers only a person's own `manual`
 * session of this project; a card worker, a fleet slot or an unknown session
 * is refused before anything changes. Shared by the Board handlers and — C-377
 * — the stack, design and dependency handlers.
 */
@Injectable()
export class LocalManualGate {
  constructor(private readonly terminal: BoardTerminalService) {}

  /** The asking session when it is a person's own; `null` when it is not. */
  async manualOf(call: LocalCall): Promise<ManualSession | null> {
    const asking = call.session;
    if (!asking || asking.runtime !== 'claude') return null;
    try {
      return await this.terminal.manualSession(
        { id: projectOf(call).id, runnerId: call.runnerId },
        asking.id,
      );
    } catch (error) {
      if (error instanceof NotAManualSession) return null;
      throw error;
    }
  }

  /** `work` as a person's own session, or `refusal` (`not_a_manual_session`). */
  async control<T>(
    call: LocalCall,
    work: (session: ManualSession) => Promise<T>,
    refusal: () => LocalError = notManual,
  ): Promise<T> {
    const session = await this.manualOf(call);
    if (!session) throw refusal();
    try {
      return await work(session);
    } catch (error) {
      if (error instanceof BoardSessionRefusal) {
        throw new LocalError(error.code, error.message);
      }
      throw error;
    }
  }
}

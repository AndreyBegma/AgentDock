import { randomUUID } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { SessionMessageOutcome } from '@nautelle/shared';
import type {
  SessionMessageArgs,
  SessionMessageResult,
  WatchedProject,
} from '@nautelle/shared/protocol';
import type { CardRecord } from '../cards/record';
import { type Clock, isoNow } from '../clock';
import { EVENTS_FILE } from '../collectors/events/events';
import { CommandFailure } from '../commands/failure';
import { resolveSlot, watchedProject } from '../control/target';
import { TmuxControl } from '../control/tmux';
import type { Exec } from '../detect/exec';
import { issueOfSlot, resolveFleetProject } from '../fleet/project';
import { errorMessage, type Logger } from '../log';
import { answerQuestion, type DeliveryTmux, deliverText } from './deliver';

/** What `session.message` needs of the card executor. */
export interface SessionMessageCards {
  record(cardId: string): CardRecord | null;
  liveSession(projectId: string, cardId: string, runId: string): string | null;
}

export interface SessionMessengerOptions {
  cards?: SessionMessageCards;
  exec: Exec;
  clock: Clock;
  watchedProjects: () => readonly WatchedProject[];
  log: Logger;
  /** The tmux server: empty for the user's own, `['-L', name]` in tests. */
  tmuxServer?: readonly string[];
}

/**
 * `slot.message_sent` with `by: person` (#489 M5), as one line of the
 * orchestrator's `events.jsonl` in the schema its plugin writes — so the
 * orchestrator, which reads its own log, knows what each worker was told.
 */
export const slotMessageLine = (
  slot: string,
  text: string,
  at: string,
  project: { repo: string; root: string },
): string =>
  `${JSON.stringify({
    v: 1,
    eid: `agentdock-${randomUUID()}`,
    ts: at,
    type: 'slot.message_sent',
    source: 'agentdock',
    project,
    slot,
    ...(issueOfSlot(slot) !== undefined ? { issue: issueOfSlot(slot) } : {}),
    data: { slot, text, by: 'person' },
  })}\n`;

/** Appends `slotMessageLine` to the orchestrator's `events.jsonl` (M5). */
export const appendSlotMessage = async (
  exec: Exec,
  project: WatchedProject,
  slot: string,
  text: string,
  at: string,
): Promise<void> => {
  const fleet = await resolveFleetProject(exec, project);
  await mkdir(fleet.boardDir, { recursive: true });
  await appendFile(
    join(fleet.boardDir, EVENTS_FILE),
    slotMessageLine(slot, text, at, { repo: fleet.repo, root: fleet.root }),
    { encoding: 'utf8', mode: 0o600 },
  );
};

/**
 * #489, ADR-0010: `session.message` — a person's text or answer, delivered
 * to a card round's session or a fleet slot's `cs-*` pane through the one
 * delivery path (`deliverText`, `answerQuestion`). The session is resolved
 * here, never taken from args; the args schema has already refused text
 * that is not clean.
 */
export class SessionMessenger {
  private readonly tmux: TmuxControl;

  constructor(private readonly options: SessionMessengerOptions) {
    this.tmux = new TmuxControl(options.exec, options.tmuxServer ?? []);
  }

  async message(args: SessionMessageArgs): Promise<SessionMessageResult> {
    const { target } = args;
    if (target.kind === 'card_round') {
      const session = this.cardSession(args.projectId, target);
      return { outcome: await this.deliver(this.tmux, session, args) };
    }
    const project = watchedProject(
      { projectId: args.projectId, root: target.root },
      this.options.watchedProjects(),
    );
    const slot = await resolveSlot(
      this.options.exec,
      this.tmux,
      project,
      target.slot,
    );
    const outcome = await this.deliver(
      this.tmux,
      slot.sessions[0] ?? null,
      args,
    );
    if (outcome === 'sent' || outcome === 'answered') {
      await this.recordSlotMessage(project, target.slot, args);
    }
    return { outcome };
  }

  private cardSession(
    projectId: string,
    target: { cardId: string; runId: string },
  ): string | null {
    const cards = this.options.cards;
    if (!cards) {
      throw new CommandFailure(
        'unsupported',
        'this runner does not run board card workers',
      );
    }
    const record = cards.record(target.cardId);
    if (!record || record.projectId !== projectId) {
      throw new CommandFailure(
        'not_found',
        `card ${target.cardId} is not in ${projectId} on this runner`,
      );
    }
    if (record.runId !== target.runId) {
      throw new CommandFailure(
        'not_found',
        `round ${target.runId} is not card ${target.cardId}'s current round`,
      );
    }
    return cards.liveSession(projectId, target.cardId, target.runId);
  }

  private async deliver(
    tmux: DeliveryTmux,
    session: string | null,
    args: SessionMessageArgs,
  ): Promise<SessionMessageOutcome> {
    if (session === null) return 'no_session';
    const { message } = args;
    switch (message.kind) {
      case 'text':
        return deliverText(tmux, session, message.text);
      case 'option':
        return answerQuestion(tmux, session, message.questionKey, {
          index: message.index,
        });
      case 'other':
        return answerQuestion(tmux, session, message.questionKey, {
          text: message.text,
        });
    }
  }

  /**
   * M5: the orchestrator's own log learns what the worker was told. The
   * message has reached the pane by then: a failed append is logged, never
   * reported as an undelivered message.
   */
  private async recordSlotMessage(
    project: WatchedProject,
    slot: string,
    args: SessionMessageArgs,
  ): Promise<void> {
    const { message } = args;
    const text =
      message.kind === 'option'
        ? `answered option ${message.index}`
        : message.text;
    try {
      await appendSlotMessage(
        this.options.exec,
        project,
        slot,
        text,
        isoNow(this.options.clock),
      );
    } catch (error) {
      this.options.log.warn('session: recording a slot message failed', {
        slot,
        error: errorMessage(error),
      });
    }
  }
}

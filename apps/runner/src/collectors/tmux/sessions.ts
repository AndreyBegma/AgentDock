import type { FleetEmitter, FleetProject } from '../../fleet/project';
import { ownedSlot } from '../../fleet/session-name';
import type { SlotBook } from '../../fleet/slots';
import {
  AGENT_FILE_MAX_BYTES,
  readRegularFileInside,
} from '../../fs/safe-read';
import type { QuotaResumer } from '../../quota/resume';
import { classifyPane } from './classify';
import { sessionPanes, type TmuxPane } from './tmux';
import { type PaneChange, PaneTracker } from './tracker';

export const REPLY_FILE = '.orchestrator-reply.md';

interface Live {
  session: string;
  tracker: PaneTracker;
}

export interface SlotSessionsOptions {
  project: FleetProject;
  book: SlotBook;
  emit: FleetEmitter;
  /** Captures a pane's visible text; null when it cannot. */
  capture: (paneId: string) => Promise<string | null>;
  /** The clock a banner's reset time is read against. Defaults to the system's. */
  now?: () => number;
  /**
   * Resumes a slot's session when its limit resets (spec 741 D4). Absent: the
   * limit is reported and nothing is typed.
   */
  resume?: {
    resumer: QuotaResumer;
    /** Types `text` into the pane, then submits it. */
    type: (paneId: string, text: string) => Promise<void>;
  };
}

/** Emits a tracker's changes for one pane, as slot or orchestrator events. */
export const emitPaneChanges = (
  emit: FleetEmitter,
  changes: readonly PaneChange[],
  scope:
    | { target: 'slot'; slot: string; issue?: number }
    | { target: 'orchestrator' },
): void => {
  for (const { type, ...fields } of changes) {
    const data = { target: scope.target, ...fields };
    if (scope.target === 'slot') {
      emit(type, data, { slot: scope.slot, issue: scope.issue });
    } else {
      emit(type, data);
    }
  }
};

/**
 * A project's slot sessions (D1, D2, D12): which `cs-*` sessions are this
 * project's, when they appear and vanish, and what their panes show.
 *
 * The runner keeps no state across restarts, so the first poll cannot know
 * which sessions died while it was down. It reports `session.vanished` for a
 * slot whose worktree holds a reply file (its worker ran) and that has no
 * session now, and says nothing about a slot without one — that may be a
 * brief whose session has not launched yet.
 */
export class SlotSessions {
  private live = new Map<string, Live>();
  private first = true;

  constructor(private readonly options: SlotSessionsOptions) {}

  async poll(panes: readonly TmuxPane[]): Promise<void> {
    const { project, book, emit } = this.options;
    const ownership = {
      root: project.root,
      worktreeSlots: new Set(book.worktrees.keys()),
      configuredPrefix: project.sessionPrefix,
    };
    const seen = new Map<string, TmuxPane>();
    const sessions = new Map<string, string>();
    for (const [session, pane] of sessionPanes(panes)) {
      const slot = ownedSlot(session, ownership);
      if (!slot || seen.has(slot)) continue;
      seen.set(slot, pane);
      sessions.set(slot, session);
    }

    if (this.first) {
      this.first = false;
      for (const [slot, worktree] of book.worktrees) {
        if (
          seen.has(slot) ||
          readRegularFileInside(
            worktree.path,
            REPLY_FILE,
            AGENT_FILE_MAX_BYTES,
          ) === null
        ) {
          continue;
        }
        emit(
          'session.vanished',
          { name: `cs-${slot}` },
          { slot, issue: book.issue(slot) },
        );
      }
    }

    for (const [slot, live] of this.live) {
      if (sessions.get(slot) === live.session) continue;
      this.live.delete(slot);
      this.options.resume?.resumer.forget(`slot:${slot}`);
      emit(
        'session.vanished',
        { name: live.session },
        { slot, issue: book.issue(slot) },
      );
    }
    for (const [slot, session] of sessions) {
      if (this.live.has(slot)) continue;
      this.live.set(slot, { session, tracker: new PaneTracker() });
      emit(
        'session.appeared',
        { name: session },
        { slot, issue: book.issue(slot) },
      );
    }

    for (const [slot, pane] of seen) {
      const live = this.live.get(slot);
      const text = await this.options.capture(pane.paneId);
      if (!live || text === null) continue;
      const reading = classifyPane(text, {
        now: new Date(this.options.now?.() ?? Date.now()),
      });
      const scope = { target: 'slot' as const, slot, issue: book.issue(slot) };
      emitPaneChanges(emit, live.tracker.next(reading), scope);
      const { resume } = this.options;
      resume?.resumer.observe(
        `slot:${slot}`,
        reading.quota,
        {
          capture: () => this.options.capture(pane.paneId),
          type: (typed) => resume.type(pane.paneId, typed),
        },
        () => emitPaneChanges(emit, [{ type: 'pane.quota_resumed' }], scope),
      );
    }
  }
}

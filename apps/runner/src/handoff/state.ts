import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  HANDOFF_NOTE_PATH,
  handoffNoteSchema,
  handoffUpdatedBySchema,
} from '@agentdock/shared';
import { z } from 'zod';
import { readJson, writeJsonAtomic } from '../skills/run/record';

/**
 * Context handoff's state on the machine (#449 D4). The note the agent keeps
 * is `.agentdock/handoff.md` in the card's worktree (git-excluded with the
 * rest of `.agentdock/`), and `<run dir>/handoff.md` for a design or planner
 * run. Beside the card's record the runner keeps what the note file cannot
 * be trusted with: the last accepted note and **its person lines** — set only
 * by `card.handoff.set`, never read back from marks in the file (DA-05).
 */

/** The note, worktree-relative. */
export const HANDOFF_NOTE_FILE = HANDOFF_NOTE_PATH;

/** A run's note, in its run directory. */
export const RUN_HANDOFF_FILE = 'handoff.md';

/** Beside the card's `state.json`. */
export const HANDOFF_STATE_FILE = 'handoff.json';

/** Round 1's prompt, beside the card's `state.json`: the fresh start's card prompt (D3). */
export const CARD_PROMPT_FILE = 'card-prompt.md';

/** The note's path in a worktree. */
export const handoffNotePath = (worktree: string): string =>
  join(worktree, HANDOFF_NOTE_FILE);

/** The rounds kept in `asked`; older ones can never be asked again anyway. */
const ASKED_KEPT = 20;
/** Sessions kept in `sessions`. */
const SESSIONS_KEPT = 50;

export const handoffStateSchema = z.object({
  /** The last note the runner accepted, with the person's lines (D7). */
  note: handoffNoteSchema
    .and(
      z.object({
        updatedBy: handoffUpdatedBySchema,
        updatedAt: z.iso.datetime(),
      }),
    )
    .nullable(),
  /** The card's number, from round 1's prompt; for `resume_context`. */
  number: z.number().int().positive().optional(),
  /** D8: the rounds already asked once to refresh a stale note. */
  asked: z.array(z.string().min(1)).default([]),
  /**
   * #494, D8: the round found stale before a compaction. Its one refresh
   * request rides on the `SessionStart` that follows the compaction — no
   * hook can reach the model before it — and is cleared once that started.
   */
  compactAsk: z.string().min(1).optional(),
  /** The note content last refused, so one refusal is sent once. */
  refused: z.string().optional(),
  /** D3: every session the card ran in, oldest first — none is discarded. */
  sessions: z.array(z.uuid()).default([]),
  /** D9: the current round's warm-up clock. */
  warmup: z
    .object({
      runId: z.string().min(1),
      sessionId: z.uuid(),
      startedAt: z.number().int().nonnegative(),
      reported: z.boolean(),
    })
    .optional(),
});
export type HandoffState = z.infer<typeof handoffStateSchema>;
export type StoredNote = NonNullable<HandoffState['note']>;

/** A card with no state yet; fresh arrays each time, never shared. */
export const emptyHandoffState = (): HandoffState => ({
  note: null,
  asked: [],
  sessions: [],
});

/** Reads and writes `handoff.json` and `card-prompt.md` in a card's directory. */
export class HandoffStateStore {
  constructor(private readonly cardDir: (cardId: string) => string) {}

  load(cardId: string): HandoffState {
    return (
      readJson(
        join(this.cardDir(cardId), HANDOFF_STATE_FILE),
        handoffStateSchema,
      ) ?? emptyHandoffState()
    );
  }

  save(cardId: string, state: HandoffState): void {
    mkdirSync(this.cardDir(cardId), { recursive: true, mode: 0o700 });
    writeJsonAtomic(join(this.cardDir(cardId), HANDOFF_STATE_FILE), {
      ...state,
      asked: state.asked.slice(-ASKED_KEPT),
      sessions: state.sessions.slice(-SESSIONS_KEPT),
    });
  }

  update(cardId: string, change: (state: HandoffState) => void): HandoffState {
    const state = this.load(cardId);
    change(state);
    this.save(cardId, state);
    return state;
  }

  saveCardPrompt(cardId: string, prompt: string): void {
    mkdirSync(this.cardDir(cardId), { recursive: true, mode: 0o700 });
    writeFileSync(join(this.cardDir(cardId), CARD_PROMPT_FILE), prompt, {
      mode: 0o600,
    });
  }

  cardPrompt(cardId: string): string | null {
    try {
      return readFileSync(join(this.cardDir(cardId), CARD_PROMPT_FILE), 'utf8');
    } catch {
      return null;
    }
  }
}

/** Adds a session to the kept list once (D3: the old session stays resumable). */
export const keepSession = (state: HandoffState, sessionId: string): void => {
  if (!state.sessions.includes(sessionId)) state.sessions.push(sessionId);
};

/** `## Card C-<n>: <title>` — the header `cardWorkerPrompt` writes. */
const CARD_HEADER = /^## Card C-(\d{1,9}): /m;

/** The card's number from round 1's prompt; null when it has no header. */
export const cardNumberOfPrompt = (prompt: string): number | null => {
  const match = CARD_HEADER.exec(prompt);
  const number = match ? Number(match[1]) : NaN;
  return Number.isSafeInteger(number) && number > 0 ? number : null;
};

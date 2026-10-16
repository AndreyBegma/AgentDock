import { z } from 'zod';
import { handoffContentSchema } from './note';
import {
  type HandoffLineRange,
  handoffPersonLinesSchema,
  personLinesFit,
} from './person-lines';

/**
 * Context handoff (#449, ADR-0042). Every card and every long run (design,
 * planner) keeps a short structured note; the runner starts the next round or
 * session from `--resume` or from the note, whichever costs less on its first
 * turn. On with Token saver: a launch's `tokenSaver.enabled` is the switch
 * (no setting of its own).
 */

/** D1: what a note belongs to — a board card, or a design or planner run. */
export const HANDOFF_SUBJECT_KINDS = ['card', 'run'] as const;
export const handoffSubjectKindSchema = z.enum(HANDOFF_SUBJECT_KINDS);
export type HandoffSubjectKind = z.infer<typeof handoffSubjectKindSchema>;

/** D2, D7: the agent in its session, haiku from a dead session's transcript, or a person. */
export const HANDOFF_UPDATED_BY = ['agent', 'haiku', 'person'] as const;
export const handoffUpdatedBySchema = z.enum(HANDOFF_UPDATED_BY);
export type HandoffUpdatedBy = z.infer<typeof handoffUpdatedBySchema>;

/**
 * D3: how a round's session started — `resume` (`--resume`), `fresh` (a new
 * session seeded with the note, the diff and the checklist), `first` (the
 * card's first round: nothing to resume, no note yet).
 */
export const CARD_RESTART_MODES = ['resume', 'fresh', 'first'] as const;
export const cardRestartModeSchema = z.enum(CARD_RESTART_MODES);
export type CardRestartMode = z.infer<typeof cardRestartModeSchema>;

const tokenCount = z.number().int().nonnegative().max(100_000_000);

/**
 * D3: the estimated first-turn input of each way to start. `resumeTokens` is
 * the session history, priced as a cache read when `cacheWarm` and as
 * uncached input otherwise; `freshTokens` is the note, the diff summary, the
 * checklist and the card prompt. Stored on the round as `restartEstimate`.
 */
export const restartEstimateSchema = z.strictObject({
  resumeTokens: tokenCount,
  freshTokens: tokenCount,
  cacheWarm: z.boolean(),
});
export type RestartEstimate = z.infer<typeof restartEstimateSchema>;

/** A note's fields, for the schemas that carry one beside their own. */
export const handoffNoteFields = {
  content: handoffContentSchema,
  personLines: handoffPersonLinesSchema,
};

/** Pass to `.refine` on any object with `handoffNoteFields`. */
export const handoffNoteFits = (note: {
  content: string;
  personLines: HandoffLineRange[];
}): boolean => personLinesFit(note.content, note.personLines);
export const HANDOFF_NOTE_FIT_ISSUE = {
  message: 'a person range is past the last line',
  path: ['personLines'],
};

/** A note with its person lines, valid by D5 and D7. */
export const handoffNoteSchema = z
  .object(handoffNoteFields)
  .refine(handoffNoteFits, HANDOFF_NOTE_FIT_ISSUE);
export type HandoffNote = z.infer<typeof handoffNoteSchema>;

// HTTP (i449-api, i449-web)

/** One note as the card sheet shows it. */
export interface HandoffNoteView {
  content: string;
  personLines: HandoffLineRange[];
  updatedBy: HandoffUpdatedBy;
  updatedAt: string;
}

/**
 * `GET /board/cards/:number/handoff`. `shipContent: false` is the sheet's
 * "kept on the machine" empty state (D4, ADR-0021) — the API holds no note
 * then. `note` is null while the card has none yet.
 */
export interface CardHandoffView {
  shipContent: boolean;
  note: HandoffNoteView | null;
}

/**
 * `PUT /board/cards/:number/handoff` (operator, D7): the whole edited note.
 * The API marks the person's lines itself (`markPersonEdit` against the note
 * it holds), stores the copy and sends `card.handoff.set`. Refused while the
 * project ships no content. Answers with `CardHandoffView`.
 */
export interface PutCardHandoffBody {
  content: string;
}

/**
 * D9: the card's chip — `resumed from handoff · saved ≈ $x` after a fresh
 * start, `resumed session` after `--resume`, nothing for a first round.
 * `savedUsd` is a decimal string, like `costUsd`.
 */
export const restartChipLabel = (
  mode: CardRestartMode | null | undefined,
  savedUsd: string | null | undefined,
): string | null => {
  if (mode === 'resume') return 'resumed session';
  if (mode !== 'fresh') return null;
  const saved = Number(savedUsd);
  if (savedUsd == null || !Number.isFinite(saved) || saved <= 0) {
    return 'resumed from handoff';
  }
  return `resumed from handoff · saved ≈ $${saved.toFixed(2)}`;
};

// The `resume_context` MCP tool (D6)

/**
 * `resume_context`: the agentdock MCP server's tool for a person's own
 * terminal session. The runner answers it from the note on the machine (D4)
 * — the API is not asked, so it works with session content off. The card is
 * resolved from the session: its worktree, or a checkout on the card's
 * branch. No argument names a card or a path.
 */
export const RESUME_CONTEXT_TOOL = 'resume_context';

export const resumeContextArgsSchema = z.strictObject({});
export type ResumeContextArgs = z.infer<typeof resumeContextArgsSchema>;

export const resumeContextResultSchema = z.discriminatedUnion('found', [
  z
    .object({
      found: z.literal(true),
      card: z.object({
        number: z.number().int().positive(),
        /** `C-<number>`. */
        label: z.string().min(1),
      }),
      ...handoffNoteFields,
      updatedBy: handoffUpdatedBySchema,
      updatedAt: z.iso.datetime(),
    })
    .refine(handoffNoteFits, HANDOFF_NOTE_FIT_ISSUE),
  z.object({
    found: z.literal(false),
    /**
     * `not_a_card_session`: the session is in no card's worktree or branch;
     * `no_note`: the card has no note yet.
     */
    reason: z.enum(['not_a_card_session', 'no_note']),
  }),
]);
export type ResumeContextResult = z.infer<typeof resumeContextResultSchema>;

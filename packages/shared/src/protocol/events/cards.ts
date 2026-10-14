import { z } from 'zod';
import { cardIdSchema, cardTmuxSessionSchema } from '../commands/cards';
import { skillRunIdSchema } from '../commands/skills';

/**
 * Card worker events (issue #242 "Runner"). A round outlives the `card.run`
 * command that started it, so its progress travels in the event stream.
 * `source: "runner"`; the envelope's `project` names the project, and
 * `data.projectId` repeats its id so the API can match the round without a
 * lookup. What Claude does inside the session arrives as `hook.*` events of
 * the card's session id (D6).
 */

/**
 * The runner's view of a round. `ended` is the tmux session gone (D6, polled
 * every `CARD_SESSION_POLL_MS`); `failed` is a round that could not start.
 */
export const cardRunPhaseSchema = z.enum([
  'starting',
  'running',
  'ended',
  'failed',
]);
export type CardRunPhase = z.infer<typeof cardRunPhaseSchema>;

const absolutePath = z
  .string()
  .min(1)
  .max(4096)
  .refine((p) => p.startsWith('/'), { message: 'must be an absolute path' });

export const cardRunPhaseChangedDataSchema = z.object({
  cardId: cardIdSchema,
  runId: skillRunIdSchema,
  projectId: z.string().min(1),
  phase: cardRunPhaseSchema,
  at: z.iso.datetime(),
  tmuxSession: cardTmuxSessionSchema.optional(),
  /** Display only. */
  worktree: absolutePath.optional(),
  /** `exec-run`'s `exit.json`, on `ended`; absent when the session was killed. */
  exitCode: z.number().int().optional(),
  /** Why a round failed, without a stack trace. */
  error: z.string().min(1).max(500).optional(),
});
export type CardRunPhaseChangedData = z.infer<
  typeof cardRunPhaseChangedDataSchema
>;

/** `data` schema of every card run event type. */
export const cardRunEventDataSchemas = {
  'card_run.phase_changed': cardRunPhaseChangedDataSchema,
} as const;

export type CardRunEventType = keyof typeof cardRunEventDataSchemas;
export const CARD_RUN_EVENT_TYPES = Object.keys(
  cardRunEventDataSchemas,
) as CardRunEventType[];

export const isCardRunEventType = (type: string): type is CardRunEventType =>
  Object.hasOwn(cardRunEventDataSchemas, type);

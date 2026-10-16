import { z } from 'zod';
import {
  HANDOFF_NOTE_FIT_ISSUE,
  handoffNoteFields,
  handoffNoteFits,
} from '../../handoff/contracts';
import type { CommandDefinition } from '../commands';
import { cardIdSchema, cardShortIdSchema } from './cards';

/**
 * Context handoff's command (#449 D7, ADR-0010). A person edited a card's
 * note in the card sheet; the API marked their lines and sends the whole
 * note here, and the runner writes it to `.agentdock/handoff.md` in the
 * card's worktree with the person marks (`markPersonLines`). The runner then
 * reports it as `handoff.updated` with `updatedBy: 'person'`.
 *
 * The API sends it only to a runner whose capabilities say `handoff: true`.
 *
 * `handoffCommands` is defined and exported here, but entered in the
 * `commands` allowlist only together with its runner handler: the runner's
 * `CommandHandlers` needs a handler for every key of that map (the card,
 * text and Steward precedent).
 *
 * No argument is a path: the worktree is resolved from `shortId`.
 */

export const HANDOFF_COMMAND_TIMEOUT_MS = 15_000;

export const cardHandoffSetArgsSchema = z
  .strictObject({
    projectId: z.string().min(1),
    cardId: cardIdSchema,
    shortId: cardShortIdSchema,
    ...handoffNoteFields,
  })
  .refine(handoffNoteFits, HANDOFF_NOTE_FIT_ISSUE);
export type CardHandoffSetArgs = z.infer<typeof cardHandoffSetArgsSchema>;

/**
 * `applied`: written to the worktree. `no_worktree`: the card has none on
 * this machine (never run, or cleaned up) — nothing is written, and the next
 * round's first `handoff.updated` is the agent's.
 */
export const cardHandoffSetResultSchema = z.object({
  outcome: z.enum(['applied', 'no_worktree']),
});
export type CardHandoffSetResult = z.infer<typeof cardHandoffSetResultSchema>;

export const handoffCommands = {
  'card.handoff.set': {
    args: cardHandoffSetArgsSchema,
    result: cardHandoffSetResultSchema,
    minRole: 'operator',
    timeoutMs: HANDOFF_COMMAND_TIMEOUT_MS,
  },
} as const satisfies Record<string, CommandDefinition>;

export type HandoffCommandName = keyof typeof handoffCommands;
export const HANDOFF_COMMAND_NAMES = Object.keys(
  handoffCommands,
) as HandoffCommandName[];

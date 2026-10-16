import { z } from 'zod';
import {
  sessionMessageInputSchema,
  sessionMessageOutcomeSchema,
} from '../../session-message/contracts';
import type { CommandDefinition } from '../commands';
import { absolutePathSchema } from '../projects';
import { cardIdSchema } from './cards';
import { slotNameSchema } from './control';
import { skillRunIdSchema } from './skills';

/**
 * #489, ADR-0010: a person's message to a running session — text typed and
 * submitted, or the answer to the question selector the pane shows. The API
 * sends it only to a runner whose capabilities say `sessionMessage: true`.
 *
 * No argument names a tmux session: a card round's session is the runner's
 * record of that round, a slot's the live `cs-*` session of its worktree.
 * Every key sent is fixed by the runner — the text with `send-keys -l`, then
 * Enter in a call of its own; an answer as cursor moves and Enter — never
 * keystrokes from the args.
 */

export const SESSION_MESSAGE_TIMEOUT_MS = 15_000;

export const sessionMessageTargetSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('card_round'),
    cardId: cardIdSchema,
    runId: skillRunIdSchema,
  }),
  /**
   * M5: a fleet worker. `root` must be the watched project's; the message is
   * also appended to the orchestrator's `events.jsonl` as
   * `slot.message_sent` with `by: person`.
   */
  z.strictObject({
    kind: z.literal('fleet_slot'),
    root: absolutePathSchema,
    slot: slotNameSchema,
  }),
]);
export type SessionMessageTarget = z.infer<typeof sessionMessageTargetSchema>;

export const sessionMessageArgsSchema = z.strictObject({
  projectId: z.string().min(1),
  target: sessionMessageTargetSchema,
  message: sessionMessageInputSchema,
});
export type SessionMessageArgs = z.infer<typeof sessionMessageArgsSchema>;

export const sessionMessageResultSchema = z.object({
  outcome: sessionMessageOutcomeSchema,
});
export type SessionMessageResult = z.infer<typeof sessionMessageResultSchema>;

export const sessionMessageCommands = {
  'session.message': {
    args: sessionMessageArgsSchema,
    result: sessionMessageResultSchema,
    minRole: 'operator',
    timeoutMs: SESSION_MESSAGE_TIMEOUT_MS,
  },
} as const satisfies Record<string, CommandDefinition>;

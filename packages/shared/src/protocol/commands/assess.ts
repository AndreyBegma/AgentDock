import { z } from 'zod';
import {
  CARD_ASSESS_MAX_TIMEOUT_SEC,
  CARD_ASSESS_MIN_TIMEOUT_SEC,
  CARD_ASSESS_MODEL,
  CARD_ASSESS_PROMPT_MAX_BYTES,
} from '../../assess/limits';
import { tokenSaverConfigSchema } from '../../token-saver/contracts';
import type { CommandDefinition } from '../commands';
import { profileKeySchema, skillRunIdSchema } from './skills';

/**
 * A card's model assessment on the runner (issue #322 D5, ADR-0032). The API
 * has no model key, so the recommendation is headless `claude -p` with
 * `haiku`, no tools, `--permission-mode plan`, the prompt on stdin, in a run
 * directory outside every watched root and with `AGENTDOCK_HOOKS=off` —
 * exactly as `text.normalize` does (ADR-0027).
 *
 * `assessCommands` is defined and exported here, but entered in the
 * `commands` allowlist only together with its runner handler: the runner's
 * `CommandHandlers` needs a handler for every key of that map, so an entry
 * without one breaks the runner build (the capture and text precedent).
 *
 * The runner does not parse the result: `card_assess.finished` returns the
 * text, and the API checks it against `cardAssessAnswerSchema`.
 */

/** `card.assess` returns once the process is started. */
export const CARD_ASSESS_COMMAND_TIMEOUT_MS = 15_000;

const utf8Bytes = (text: string): number =>
  new TextEncoder().encode(text).length;

export const cardAssessPromptSchema = z
  .string()
  .min(1)
  .refine((t) => !t.includes('\u0000'), { message: 'must not contain NUL' })
  .refine((t) => utf8Bytes(t) <= CARD_ASSESS_PROMPT_MAX_BYTES, {
    message: `must be at most ${CARD_ASSESS_PROMPT_MAX_BYTES} bytes`,
  });

/**
 * `card.assess`. `runId` is the `runs` row of kind `card_assess`; it names the
 * run directory. `sessionId` is the Claude session the API picks
 * (`--session-id`), so the run is priced from that session (ADR-0009). The
 * model is always `haiku` (D5).
 */
export const cardAssessArgsSchema = z.strictObject({
  runId: skillRunIdSchema,
  projectId: z.string().min(1),
  sessionId: z.uuid(),
  prompt: cardAssessPromptSchema,
  profileKey: profileKeySchema,
  model: z.literal(CARD_ASSESS_MODEL),
  timeoutSec: z
    .number()
    .int()
    .min(CARD_ASSESS_MIN_TIMEOUT_SEC)
    .max(CARD_ASSESS_MAX_TIMEOUT_SEC),
  /** #445 D11: as on `card.run`. */
  tokenSaver: tokenSaverConfigSchema.optional(),
});
export type CardAssessArgs = z.infer<typeof cardAssessArgsSchema>;

export const cardAssessResultSchema = z.object({
  phase: z.enum(['starting', 'running']),
});
export type CardAssessResult = z.infer<typeof cardAssessResultSchema>;

export const assessCommands = {
  'card.assess': {
    args: cardAssessArgsSchema,
    result: cardAssessResultSchema,
    minRole: 'operator',
    timeoutMs: CARD_ASSESS_COMMAND_TIMEOUT_MS,
  },
} as const satisfies Record<string, CommandDefinition>;

export type AssessCommandName = keyof typeof assessCommands;

import { z } from 'zod';
import {
  TEXT_NORMALIZE_MAX_TIMEOUT_SEC,
  TEXT_NORMALIZE_MIN_TIMEOUT_SEC,
  TEXT_NORMALIZE_MODEL,
  TEXT_PROMPT_MAX_BYTES,
} from '../../text/limits';
import { tokenSaverConfigSchema } from '../../token-saver/contracts';
import type { CommandDefinition } from '../commands';
import { profileKeySchema, skillRunIdSchema } from './skills';

/**
 * Text normalization on the runner (issue #271 "Runner", D4, ADR-0027). The
 * API has no model key, so a translation runs on the project's runner as
 * headless `claude -p` with no tools, `--permission-mode plan`, the prompt on
 * stdin, in a run directory outside every watched root and with
 * `NAUTELLE_HOOKS=off` — exactly as `cards.extract` does (ADR-0026).
 *
 * `textCommands` is defined and exported here, but entered in the `commands`
 * allowlist only together with its runner handler: the runner's
 * `CommandHandlers` needs a handler for every key of that map, so an entry
 * without one breaks the runner build (the capture precedent).
 *
 * The runner does not parse the result: `text_normalize.finished` returns the
 * text, and the API checks it against the contract (`parseNormalizeOutput`).
 */

/** `text.normalize` returns once the process is started. */
export const TEXT_NORMALIZE_COMMAND_TIMEOUT_MS = 15_000;

const utf8Bytes = (text: string): number =>
  new TextEncoder().encode(text).length;

export const textPromptSchema = z
  .string()
  .min(1)
  .refine((t) => !t.includes('\u0000'), { message: 'must not contain NUL' })
  .refine((t) => utf8Bytes(t) <= TEXT_PROMPT_MAX_BYTES, {
    message: `must be at most ${TEXT_PROMPT_MAX_BYTES} bytes`,
  });

/**
 * `text.normalize`. `runId` is the `runs` row of kind `text_normalize`; it
 * names the run directory. `sessionId` is the Claude session the API picks
 * (`--session-id`), so the run is priced from that session (ADR-0009).
 * The model is always `haiku` (D4).
 */
export const textNormalizeArgsSchema = z.strictObject({
  runId: skillRunIdSchema,
  projectId: z.string().min(1),
  sessionId: z.uuid(),
  prompt: textPromptSchema,
  profileKey: profileKeySchema,
  model: z.literal(TEXT_NORMALIZE_MODEL),
  timeoutSec: z
    .number()
    .int()
    .min(TEXT_NORMALIZE_MIN_TIMEOUT_SEC)
    .max(TEXT_NORMALIZE_MAX_TIMEOUT_SEC),
  /** #445 D11: as on `card.run`. */
  tokenSaver: tokenSaverConfigSchema.optional(),
});
export type TextNormalizeArgs = z.infer<typeof textNormalizeArgsSchema>;

export const textNormalizeResultSchema = z.object({
  phase: z.enum(['starting', 'running']),
});
export type TextNormalizeResult = z.infer<typeof textNormalizeResultSchema>;

export const textCommands = {
  'text.normalize': {
    args: textNormalizeArgsSchema,
    result: textNormalizeResultSchema,
    minRole: 'operator',
    timeoutMs: TEXT_NORMALIZE_COMMAND_TIMEOUT_MS,
  },
} as const satisfies Record<string, CommandDefinition>;

export type TextCommandName = keyof typeof textCommands;

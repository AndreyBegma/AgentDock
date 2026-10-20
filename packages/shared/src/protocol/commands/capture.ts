import { z } from 'zod';
import {
  CAPTURE_MAX_TIMEOUT_SEC,
  CAPTURE_MIN_TIMEOUT_SEC,
  CAPTURE_MODELS,
} from '../../board/capture-limits';
import { bothEnvNames, readEnv } from '../../legacy-names';
import { tokenSaverConfigSchema } from '../../token-saver/contracts';
import type { CommandDefinition } from '../commands';
import { profileKeySchema, skillRunIdSchema } from './skills';

/**
 * Card capture on the runner (issue #244 "Runner", D4, ADR-0026). The API
 * has no model key, so an extraction runs on the project's runner — the
 * machine the content came from — as headless `claude -p` with no tools,
 * `--permission-mode plan`, the prompt on stdin, in a run directory outside
 * every watched root and with `NAUTELLE_HOOKS=off`, so the extraction never
 * becomes a session that is itself captured.
 *
 * `captureCommands` is defined and exported here, but entered in the
 * `commands` allowlist only together with its runner handler: the runner's
 * `CommandHandlers` needs a handler for every key of that map, so an entry
 * without one breaks the runner build (the skills and cards precedent).
 *
 * The runner does not parse the result: `cards_extract.finished` returns the
 * text, and the API checks it against the D5 contract.
 */

/** The prompt: instructions, contract, open card titles, ≤24 KiB of content. */
export const CAPTURE_PROMPT_MAX_BYTES = 48 * 1024;

/** `cards.extract` returns once the process is started. */
export const CAPTURE_EXTRACT_COMMAND_TIMEOUT_MS = 15_000;

/**
 * Hook suppression (D4). With `NAUTELLE_HOOKS=off` in its environment,
 * `nautelle-runner hook` exits 0 at once and prints nothing; the runner sets
 * it on every extraction process.
 */
export const HOOKS_ENV = 'NAUTELLE_HOOKS';
export const HOOKS_OFF = 'off';

/**
 * The environment that turns the hooks off, under both names during the
 * rename window (ADR-0073): a session may still run the old plugin's hooks.
 */
export const HOOKS_OFF_ENV: Readonly<Record<string, string>> = bothEnvNames(
  HOOKS_ENV,
  HOOKS_OFF,
);

/** Whether an environment turns the runner's hooks off. */
export const hooksDisabled = (
  env: Readonly<Record<string, string | undefined>>,
): boolean => readEnv(env, HOOKS_ENV) === HOOKS_OFF;

const utf8Bytes = (text: string): number =>
  new TextEncoder().encode(text).length;

export const capturePromptSchema = z
  .string()
  .min(1)
  .refine((t) => !t.includes('\u0000'), { message: 'must not contain NUL' })
  .refine((t) => utf8Bytes(t) <= CAPTURE_PROMPT_MAX_BYTES, {
    message: `must be at most ${CAPTURE_PROMPT_MAX_BYTES} bytes`,
  });

export const captureModelSchema = z.enum(CAPTURE_MODELS);

/**
 * `cards.extract`. `runId` is the `runs` row of kind `card_capture`; it
 * names the run directory. `sessionId` is the Claude session the API picks
 * (`--session-id`), so the run's requests are priced from that session
 * (ADR-0009) as plan turns and card rounds are.
 */
export const cardsExtractArgsSchema = z.strictObject({
  runId: skillRunIdSchema,
  projectId: z.string().min(1),
  sessionId: z.uuid(),
  prompt: capturePromptSchema,
  profileKey: profileKeySchema,
  model: captureModelSchema,
  timeoutSec: z
    .number()
    .int()
    .min(CAPTURE_MIN_TIMEOUT_SEC)
    .max(CAPTURE_MAX_TIMEOUT_SEC),
  /** #445 D11: as on `card.run`. */
  tokenSaver: tokenSaverConfigSchema.optional(),
});
export type CardsExtractArgs = z.infer<typeof cardsExtractArgsSchema>;

export const cardsExtractResultSchema = z.object({
  phase: z.enum(['starting', 'running']),
});
export type CardsExtractResult = z.infer<typeof cardsExtractResultSchema>;

export const captureCommands = {
  'cards.extract': {
    args: cardsExtractArgsSchema,
    result: cardsExtractResultSchema,
    minRole: 'operator',
    timeoutMs: CAPTURE_EXTRACT_COMMAND_TIMEOUT_MS,
  },
} as const satisfies Record<string, CommandDefinition>;

export type CaptureCommandName = keyof typeof captureCommands;

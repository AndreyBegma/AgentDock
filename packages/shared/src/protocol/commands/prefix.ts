import { z } from 'zod';
import {
  fileOverlayPartSchema,
  PREFIX_FILE_MAX_BYTES,
  PREFIX_PROPOSE_MODEL,
  PREFIX_PROPOSE_TIMEOUT_SEC,
  RULES_COMPRESS_MODEL,
  RULES_COMPRESS_TIMEOUT_SEC,
  sha256Schema,
} from '../../prefix/contracts';
import type { CommandDefinition } from '../commands';
import { absolutePathSchema } from '../projects';
import { profileKeySchema, skillRunIdSchema } from './skills';

/**
 * The launch prefix's two runner commands (docs/specs/751 B6, B8, ADR-0010).
 * Both are one headless `claude -p --tools "" --permission-mode plan` with
 * the prompt on stdin, in a run directory of its own outside every watched
 * root and with `NAUTELLE_HOOKS=off` — the `card.assess` pattern (ADR-0032
 * §1) — and both wait for the answer, as `uiprofile.learn` does. `runId` is
 * the API's `rules_compress` / `prefix_propose` run; `sessionId` prices it
 * (ADR-0009). The runner does not parse the model's text; the API does.
 */

const utf8Bytes = (text: string): number =>
  new TextEncoder().encode(text).length;

/** A rules-compression prompt carries every enabled rule, at most this big. */
export const RULES_COMPRESS_PROMPT_MAX_BYTES = 256 * 1024;
/** A model answer is cut at this many bytes, with `resultTruncated`. */
export const PREFIX_RESULT_MAX_BYTES = 256 * 1024;

const commandTimeoutMs = (timeoutSec: number): number =>
  (timeoutSec + 30) * 1000;

// rules.compress (B6)

/**
 * B6: the API builds the prompt from the database (ADR-0001) — every enabled
 * rule with its id — and expects one compressed text per rule back.
 */
export const rulesCompressArgsSchema = z.strictObject({
  runId: skillRunIdSchema,
  projectId: z.string().min(1),
  sessionId: z.uuid(),
  prompt: z
    .string()
    .refine((p) => !p.includes('\u0000'), { message: 'must not contain NUL' })
    .refine((p) => utf8Bytes(p) <= RULES_COMPRESS_PROMPT_MAX_BYTES, {
      message: `must be at most ${RULES_COMPRESS_PROMPT_MAX_BYTES} bytes`,
    })
    .refine((p) => p.trim() !== '', { message: 'must not be empty' }),
  profileKey: profileKeySchema,
  model: z.literal(RULES_COMPRESS_MODEL),
  timeoutSec: z.number().int().min(30).max(RULES_COMPRESS_TIMEOUT_SEC),
});
export type RulesCompressArgs = z.infer<typeof rulesCompressArgsSchema>;

/** The final message, cut at `PREFIX_RESULT_MAX_BYTES` with `resultTruncated`. */
export const rulesCompressResultSchema = z.object({
  resultText: z
    .string()
    .refine((t) => utf8Bytes(t) <= PREFIX_RESULT_MAX_BYTES, {
      message: `must be at most ${PREFIX_RESULT_MAX_BYTES} bytes`,
    }),
  resultTruncated: z.boolean(),
});
export type RulesCompressResult = z.infer<typeof rulesCompressResultSchema>;

// prefix.propose (B8)

/**
 * B8: the runner reads `part` under `root` itself — the repo root
 * `CLAUDE.md` (else `.claude/CLAUDE.md`) for `claude_md`,
 * `.claude/skills/<name>/SKILL.md` for `skill:<name>` — and refuses with
 * `policy_refused` a secret-named or `code.deny` path (ADR-0063 §4,
 * ADR-0047) and a file over `PREFIX_FILE_MAX_BYTES` (ADR-0075 §2). It
 * prompts the model with `PREFIX_PROPOSE_INSTRUCTION` and the file.
 */
export const prefixProposeArgsSchema = z.strictObject({
  runId: skillRunIdSchema,
  projectId: z.string().min(1),
  root: absolutePathSchema,
  part: fileOverlayPartSchema,
  sessionId: z.uuid(),
  profileKey: profileKeySchema,
  model: z.literal(PREFIX_PROPOSE_MODEL),
  timeoutSec: z.number().int().min(30).max(PREFIX_PROPOSE_TIMEOUT_SEC),
});
export type PrefixProposeArgs = z.infer<typeof prefixProposeArgsSchema>;

const fileTextSchema = z
  .string()
  .refine((t) => utf8Bytes(t) <= PREFIX_FILE_MAX_BYTES, {
    message: `must be at most ${PREFIX_FILE_MAX_BYTES} bytes`,
  });

/**
 * B8: the original as read (its SHA-256 over the file's bytes, which the
 * launch's stale check compares) and the model's proposed replacement.
 * `path` is the file read, relative to `root`.
 */
export const prefixProposeResultSchema = z.object({
  path: z.string().min(1).max(1024),
  originalSha256: sha256Schema,
  originalText: fileTextSchema,
  proposedText: fileTextSchema,
});
export type PrefixProposeResult = z.infer<typeof prefixProposeResultSchema>;

/**
 * B8: what the proposal model is told, before the file. Shared so the
 * runner sends it verbatim and a test can pin it.
 */
export const PREFIX_PROPOSE_INSTRUCTION = [
  'You shorten an instruction file that a coding agent reads at the start of every session.',
  'Keep every rule, requirement, command, path, name and number. Drop only repetition, filler and explanatory prose the rules do not need.',
  'Keep the Markdown structure and any front matter as they are. Do not add anything.',
  'Answer with the new file only — no preamble, no code fence.',
].join('\n');

export const prefixCommands = {
  'rules.compress': {
    args: rulesCompressArgsSchema,
    result: rulesCompressResultSchema,
    minRole: 'operator',
    timeoutMs: commandTimeoutMs(RULES_COMPRESS_TIMEOUT_SEC),
  },
  'prefix.propose': {
    args: prefixProposeArgsSchema,
    result: prefixProposeResultSchema,
    minRole: 'admin',
    timeoutMs: commandTimeoutMs(PREFIX_PROPOSE_TIMEOUT_SEC),
  },
} as const satisfies Record<string, CommandDefinition>;

export type PrefixCommandName = keyof typeof prefixCommands;

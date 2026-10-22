import { z } from 'zod';
import {
  UIPROFILE_FINGERPRINT_MAX_FILES,
  UIPROFILE_FINGERPRINT_MAX_GLOBS,
  UIPROFILE_LEARN_MAX_TIMEOUT_SEC,
  UIPROFILE_LEARN_MIN_TIMEOUT_SEC,
  UIPROFILE_LEARN_MODEL,
  UIPROFILE_LEARN_PROMPT_MAX_BYTES,
  UIPROFILE_LEARN_RESULT_MAX_BYTES,
} from '../../design/limits';
import { fingerprintGlobSchema } from '../../design/types';
import { tokenSaverConfigSchema } from '../../token-saver/contracts';
import type { CommandDefinition } from '../commands';
import { absolutePathSchema } from '../projects';
import { orchestratorModelSchema } from './control';
import {
  PLAN_TURN_MAX_TIMEOUT_SEC,
  PLAN_TURN_MIN_TIMEOUT_SEC,
  PLAN_TURN_PROMPT_MAX_BYTES,
} from './planner';
import { gitRefSchema, profileKeySchema, skillRunIdSchema } from './skills';

/**
 * UI profile commands (docs/specs/223-design-stage.md "Protocol", D13,
 * ADR-0022, ADR-0010).
 *
 * `uiprofileCommands` is defined and exported here, but entered in the
 * `commands` allowlist only together with its runner handlers: the runner's
 * `CommandHandlers` needs a handler for every key of that map, so an entry
 * without one breaks the runner build (the skills and planner precedent).
 * `uiprofile.cancel` (#275) is in the map with its handler.
 *
 * The control plane never reads the project's files (ADR-0001): the build
 * runs on the runner, and the fingerprint is computed there.
 */

/** Per-command timeouts. A build returns once queued; a fingerprint reads blobs. */
export const UIPROFILE_TIMEOUTS_MS = {
  build: 30_000,
  fingerprint: 60_000,
  cancel: 15_000,
  /** #752: the learn call waits for its answer — its timeout plus the start of `claude`. */
  learn: (UIPROFILE_LEARN_MAX_TIMEOUT_SEC + 20) * 1000,
} as const;

const utf8Bytes = (text: string): number =>
  new TextEncoder().encode(text).length;

// uiprofile.build

/**
 * Creates `<parent>/.wt-<repo>-uiprofile-<shortid>` from `origin/<base>`,
 * detached; runs `claude -p --permission-mode plan` with `prompt` on stdin
 * (never as a shell string or an argv element); removes the worktree when the
 * run ends. Progress and result arrive as `uiprofile_build.*` events; the
 * runner does not parse the result.
 */
export const uiProfileBuildArgsSchema = z.strictObject({
  projectId: z.string().min(1),
  root: absolutePathSchema,
  base: gitRefSchema,
  /** The build's `runs` row (kind `ui_profile`, D13): its log relay and cost are keyed by it. */
  runId: skillRunIdSchema,
  prompt: z
    .string()
    .refine((p) => !p.includes('\u0000'), { message: 'must not contain NUL' })
    .refine((p) => utf8Bytes(p) <= PLAN_TURN_PROMPT_MAX_BYTES, {
      message: `must be at most ${PLAN_TURN_PROMPT_MAX_BYTES} bytes`,
    })
    .refine((p) => p.trim() !== '', { message: 'must not be empty' }),
  profileKey: profileKeySchema,
  model: orchestratorModelSchema,
  /** "Configuration": default `UIPROFILE_BUILD_TIMEOUT_SEC` (20 min). */
  timeoutSec: z
    .number()
    .int()
    .min(PLAN_TURN_MIN_TIMEOUT_SEC)
    .max(PLAN_TURN_MAX_TIMEOUT_SEC),
  /** #445 D11: as on `card.run`. */
  tokenSaver: tokenSaverConfigSchema.optional(),
});
export type UiProfileBuildArgs = z.infer<typeof uiProfileBuildArgsSchema>;

/** The build outlives the command: progress arrives as `uiprofile_build.*` events. */
export const uiProfileBuildResultSchema = z.object({
  phase: z.enum(['queued', 'running']),
});
export type UiProfileBuildResult = z.infer<typeof uiProfileBuildResultSchema>;

// uiprofile.fingerprint

/**
 * SHA-256 over the sorted `path:sha256` lines of the files matching `globs`
 * at `origin/<base>`, read with `git ls-tree` / `git cat-file` — never from
 * the working copy. Globs are repository-relative and confined to the
 * project root; more than `UIPROFILE_FINGERPRINT_MAX_FILES` matches is
 * `too_large`.
 */
export const uiProfileFingerprintArgsSchema = z.strictObject({
  projectId: z.string().min(1),
  root: absolutePathSchema,
  base: gitRefSchema,
  globs: z
    .array(fingerprintGlobSchema)
    .min(1)
    .max(UIPROFILE_FINGERPRINT_MAX_GLOBS),
});
export type UiProfileFingerprintArgs = z.infer<
  typeof uiProfileFingerprintArgsSchema
>;

/** `fingerprint`: lower-case hex SHA-256; `files`: how many files it covers. */
export const uiProfileFingerprintResultSchema = z.object({
  fingerprint: z
    .string()
    .regex(/^[0-9a-f]{64}$/, 'must be a SHA-256 hex digest'),
  files: z.number().int().min(0).max(UIPROFILE_FINGERPRINT_MAX_FILES),
});
export type UiProfileFingerprintResult = z.infer<
  typeof uiProfileFingerprintResultSchema
>;

// uiprofile.cancel

/**
 * #275 D5, mirroring `plan.cancel`: a queued build leaves the queue, a
 * preparing one is flagged, a running one has its session killed; each ends
 * with `uiprofile_build.finished` phase `cancelled`. An unknown run is
 * `not_found`, and so is a run of another project (`projectId`). Not in
 * `RUNNER_FEATURE_COMMANDS.design`: an older runner still generates, it just
 * cannot stop a build.
 */
export const uiProfileCancelArgsSchema = z.strictObject({
  runId: skillRunIdSchema,
  projectId: z.string().min(1),
});
export type UiProfileCancelArgs = z.infer<typeof uiProfileCancelArgsSchema>;

/** `false` when the build had already ended. */
export const uiProfileCancelResultSchema = z.object({ cancelled: z.boolean() });
export type UiProfileCancelResult = z.infer<typeof uiProfileCancelResultSchema>;

export const uiprofileCancelCommand = {
  args: uiProfileCancelArgsSchema,
  result: uiProfileCancelResultSchema,
  minRole: 'operator',
  timeoutMs: UIPROFILE_TIMEOUTS_MS.cancel,
} as const satisfies CommandDefinition;

// uiprofile.learn

/**
 * #752 A2 (ADR-0075 §6): what an approved design teaches the profile. One
 * headless `claude -p --tools "" --permission-mode plan` with the prompt on
 * stdin, in a directory of its own outside every watched root and with
 * `NAUTELLE_HOOKS=off` — the `card.assess` pattern (ADR-0032 §1). The prompt
 * carries everything (ADR-0001): the approved frames, the snippet names and
 * the comments. `runId` is the API's `ui_profile_learn` run; `sessionId`
 * prices it (ADR-0009).
 *
 * Unlike `card.assess` the command waits for the answer, as `code.ask` does:
 * the call is short, and its text comes back as the command's result. The
 * runner does not parse it; the API does.
 */
export const uiProfileLearnArgsSchema = z.strictObject({
  runId: skillRunIdSchema,
  projectId: z.string().min(1),
  sessionId: z.uuid(),
  prompt: z
    .string()
    .refine((p) => !p.includes('\u0000'), { message: 'must not contain NUL' })
    .refine((p) => utf8Bytes(p) <= UIPROFILE_LEARN_PROMPT_MAX_BYTES, {
      message: `must be at most ${UIPROFILE_LEARN_PROMPT_MAX_BYTES} bytes`,
    })
    .refine((p) => p.trim() !== '', { message: 'must not be empty' }),
  profileKey: profileKeySchema,
  model: z.literal(UIPROFILE_LEARN_MODEL),
  timeoutSec: z
    .number()
    .int()
    .min(UIPROFILE_LEARN_MIN_TIMEOUT_SEC)
    .max(UIPROFILE_LEARN_MAX_TIMEOUT_SEC),
});
export type UiProfileLearnArgs = z.infer<typeof uiProfileLearnArgsSchema>;

/** The final message, cut at `UIPROFILE_LEARN_RESULT_MAX_BYTES` with `resultTruncated`. */
export const uiProfileLearnResultSchema = z.object({
  resultText: z
    .string()
    .refine((t) => utf8Bytes(t) <= UIPROFILE_LEARN_RESULT_MAX_BYTES, {
      message: `must be at most ${UIPROFILE_LEARN_RESULT_MAX_BYTES} bytes`,
    }),
  resultTruncated: z.boolean(),
});
export type UiProfileLearnResult = z.infer<typeof uiProfileLearnResultSchema>;

/** The UI profile commands; all need an operator (spec "Protocol"). */
export const uiprofileCommands = {
  'uiprofile.build': {
    args: uiProfileBuildArgsSchema,
    result: uiProfileBuildResultSchema,
    minRole: 'operator',
    timeoutMs: UIPROFILE_TIMEOUTS_MS.build,
  },
  'uiprofile.fingerprint': {
    args: uiProfileFingerprintArgsSchema,
    result: uiProfileFingerprintResultSchema,
    minRole: 'operator',
    timeoutMs: UIPROFILE_TIMEOUTS_MS.fingerprint,
  },
  'uiprofile.cancel': uiprofileCancelCommand,
  'uiprofile.learn': {
    args: uiProfileLearnArgsSchema,
    result: uiProfileLearnResultSchema,
    minRole: 'operator',
    timeoutMs: UIPROFILE_TIMEOUTS_MS.learn,
  },
} as const satisfies Record<string, CommandDefinition>;

export type UiProfileCommandName = keyof typeof uiprofileCommands;

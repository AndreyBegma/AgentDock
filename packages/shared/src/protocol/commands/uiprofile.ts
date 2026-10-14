import { z } from 'zod';
import {
  UIPROFILE_FINGERPRINT_MAX_FILES,
  UIPROFILE_FINGERPRINT_MAX_GLOBS,
} from '../../design/limits';
import { fingerprintGlobSchema } from '../../design/types';
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
 *
 * The control plane never reads the project's files (ADR-0001): the build
 * runs on the runner, and the fingerprint is computed there.
 */

/** Per-command timeouts. A build returns once queued; a fingerprint reads blobs. */
export const UIPROFILE_TIMEOUTS_MS = {
  build: 30_000,
  fingerprint: 60_000,
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

/** The two UI profile commands; both need an operator (spec "Protocol"). */
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
} as const satisfies Record<string, CommandDefinition>;

export type UiProfileCommandName = keyof typeof uiprofileCommands;

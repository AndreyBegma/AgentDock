import { z } from 'zod';
import { planTurnPhaseSchema } from '../../planner/types';
import { skillRunIdSchema } from '../commands/skills';
import {
  PLAN_TURN_ERROR_MAX,
  PLAN_TURN_RESULT_MAX_BYTES,
  planTurnTerminalPhaseSchema,
} from './planner';

/**
 * UI profile build events (docs/specs/223-design-stage.md "Protocol"),
 * shaped like `plan_turn.*`: a build outlives the `uiprofile.build` command
 * that started it. `source: "runner"`; `data.projectId` repeats the
 * envelope's project. The runner does not parse the result: it returns the
 * text, and the API validates it with `parseUiProfileOutput`.
 */

const buildRefSchema = z.object({
  runId: skillRunIdSchema,
  projectId: z.string().min(1),
});

const utf8Bytes = (text: string): number =>
  new TextEncoder().encode(text).length;

/** Every phase transition, `queued` included. */
export const uiProfileBuildPhaseChangedDataSchema = buildRefSchema.extend({
  phase: planTurnPhaseSchema,
  at: z.iso.datetime(),
});
export type UiProfileBuildPhaseChangedData = z.infer<
  typeof uiProfileBuildPhaseChangedDataSchema
>;

/**
 * Once, when the build ends. `resultText` is cut at
 * `PLAN_TURN_RESULT_MAX_BYTES` with `resultTruncated`, which the API fails as
 * a `contract_violation` rather than parse half a block.
 */
export const uiProfileBuildFinishedDataSchema = buildRefSchema.extend({
  phase: planTurnTerminalPhaseSchema,
  at: z.iso.datetime(),
  exitCode: z.number().int().optional(),
  resultText: z
    .string()
    .refine((t) => utf8Bytes(t) <= PLAN_TURN_RESULT_MAX_BYTES, {
      message: `must be at most ${PLAN_TURN_RESULT_MAX_BYTES} bytes`,
    })
    .optional(),
  resultTruncated: z.boolean(),
  /** Why a build failed: the CLI's error, a timeout, a worktree that could not be made. */
  error: z.string().max(PLAN_TURN_ERROR_MAX).optional(),
});
export type UiProfileBuildFinishedData = z.infer<
  typeof uiProfileBuildFinishedDataSchema
>;

/** `data` schema of every UI profile build event type. */
export const uiProfileBuildEventDataSchemas = {
  'uiprofile_build.phase_changed': uiProfileBuildPhaseChangedDataSchema,
  'uiprofile_build.finished': uiProfileBuildFinishedDataSchema,
} as const;

export type UiProfileBuildEventType =
  keyof typeof uiProfileBuildEventDataSchemas;
export const UIPROFILE_BUILD_EVENT_TYPES = Object.keys(
  uiProfileBuildEventDataSchemas,
) as UiProfileBuildEventType[];

export const isUiProfileBuildEventType = (
  type: string,
): type is UiProfileBuildEventType =>
  Object.hasOwn(uiProfileBuildEventDataSchemas, type);

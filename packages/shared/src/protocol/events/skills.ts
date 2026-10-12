import { z } from 'zod';
import {
  skillFilePathSchema,
  skillRunIdSchema,
  skillRunPhaseSchema,
  skillRunSessionSchema,
  skillRunTerminalPhaseSchema,
} from '../commands/skills';

/**
 * Skill run events (spec 24, Protocol). A run outlives the `skill.run` command
 * that started it, so its progress travels in the event stream. `source:
 * "runner"`; the envelope's `project` names the project, and `data.projectId`
 * repeats its id so the API can match the run without a lookup.
 */

/** `skill_run.finished` caps (spec 24, notes: an event batch is 256 KiB). */
export const SKILL_RUN_PATCH_MAX_BYTES = 128 * 1024;
export const SKILL_RUN_REPORT_MAX_BYTES = 32 * 1024;
export const SKILL_RUN_CHANGED_FILES_MAX = 200;
/** Largest serialized `data` of `skill_run.finished`. */
export const SKILL_RUN_FINISHED_MAX_BYTES = 224 * 1024;

const utf8Bytes = (text: string): number =>
  new TextEncoder().encode(text).length;

const maxBytes = (max: number) =>
  z.string().refine((s) => utf8Bytes(s) <= max, {
    message: `must be at most ${max} bytes`,
  });

const absolutePath = z
  .string()
  .min(1)
  .max(4096)
  .refine((p) => p.startsWith('/'), { message: 'must be an absolute path' });

/** Every phase transition, `queued` included. */
export const skillRunPhaseChangedDataSchema = z.object({
  runId: skillRunIdSchema,
  projectId: z.string().min(1),
  phase: skillRunPhaseSchema,
  at: z.iso.datetime(),
  tmuxSession: skillRunSessionSchema.optional(),
  worktree: absolutePath.optional(),
  branch: z.string().min(1).max(255).optional(),
});
export type SkillRunPhaseChangedData = z.infer<
  typeof skillRunPhaseChangedDataSchema
>;

/** One `git status --porcelain` entry: the two status letters, then the path. */
export const skillRunChangedFileSchema = z.object({
  status: z.string().regex(/^[ MTADRCU?!]{2}$/, 'must be a porcelain XY code'),
  path: skillFilePathSchema,
});
export type SkillRunChangedFile = z.infer<typeof skillRunChangedFileSchema>;

/**
 * D10 fields, once, when the run reaches a terminal phase. Each part is
 * capped and flagged when cut; the full patch stays in the run directory.
 */
export const skillRunFinishedDataSchema = z
  .object({
    runId: skillRunIdSchema,
    projectId: z.string().min(1),
    phase: skillRunTerminalPhaseSchema,
    finishedAt: z.iso.datetime(),
    /** `null` when the session was killed (cancel, timeout) before it exited. */
    exitCode: z.number().int().nullable(),
    /** The final `result` message of `stream.jsonl`. */
    reportText: maxBytes(SKILL_RUN_REPORT_MAX_BYTES).optional(),
    reportTruncated: z.boolean(),
    changedFiles: z
      .array(skillRunChangedFileSchema)
      .max(SKILL_RUN_CHANGED_FILES_MAX),
    /** Every changed file, `changedFiles` holding at most the first 200. */
    changedFilesTotal: z.number().int().nonnegative(),
    /** `git diff` against the base. */
    patch: maxBytes(SKILL_RUN_PATCH_MAX_BYTES).optional(),
    patchTruncated: z.boolean(),
    prNumber: z.number().int().positive().optional(),
    prUrl: z.url({ protocol: /^https$/ }).optional(),
    /** Why a `failed` run failed, without a stack trace. */
    error: z.string().min(1).max(500).optional(),
  })
  .refine((d) => d.changedFilesTotal >= d.changedFiles.length, {
    message: 'changedFilesTotal counts at least changedFiles',
    path: ['changedFilesTotal'],
  })
  .refine((d) => (d.prNumber === undefined) === (d.prUrl === undefined), {
    message: 'prNumber and prUrl go together',
    path: ['prUrl'],
  })
  .refine((d) => utf8Bytes(JSON.stringify(d)) <= SKILL_RUN_FINISHED_MAX_BYTES, {
    message: `must serialize to at most ${SKILL_RUN_FINISHED_MAX_BYTES} bytes`,
  });
export type SkillRunFinishedData = z.infer<typeof skillRunFinishedDataSchema>;

/** `data` schema of every skill run event type. */
export const skillRunEventDataSchemas = {
  'skill_run.phase_changed': skillRunPhaseChangedDataSchema,
  'skill_run.finished': skillRunFinishedDataSchema,
} as const;

export type SkillRunEventType = keyof typeof skillRunEventDataSchemas;
export const SKILL_RUN_EVENT_TYPES = Object.keys(
  skillRunEventDataSchemas,
) as SkillRunEventType[];

export const isSkillRunEventType = (type: string): type is SkillRunEventType =>
  Object.hasOwn(skillRunEventDataSchemas, type);

import { z } from 'zod';

/**
 * The Planner (docs/specs/172-planner.md): plan, task, question and turn
 * types, and the output contract's shapes (v1). The contract is code, not
 * data (ADR-0019): every object here is strict, so a key the contract does
 * not name is a violation, never a silently dropped field.
 */

/** Bumped when the output shapes below change; each plan records the one it ran with (D11). */
export const PLANNER_CONTRACT_VERSION = 1;

/** The tag of the one fenced block a turn's final message must hold (D17). */
export const PLANNER_BLOCK_TAG = 'agentdock-plan';

/** Tasks per plan (open question: "a bigger brief is two plans"). */
export const PLANNER_MAX_TASKS = 12;
/** Questions per round. */
export const PLANNER_MAX_QUESTIONS = 8;
/** Options per question (D7). */
export const PLANNER_MAX_OPTIONS = 6;

export const PLANNER_TITLE_MAX = 200;
export const PLANNER_SUMMARY_MAX = 4000;
export const PLANNER_QUESTION_MAX = 4000;
/** Characters; the whole result travels in one event of at most 192 KiB. */
export const PLANNER_DOCUMENT_MAX = 100_000;
export const PLANNER_ASSUMPTIONS_MAX = 50;

// Plans

/** D2. */
export const PLAN_MODES = ['batch', 'dialogue'] as const;
export const planModeSchema = z.enum(PLAN_MODES);
export type PlanMode = z.infer<typeof planModeSchema>;

/** D12: private by default. */
export const PLAN_VISIBILITIES = ['private', 'project'] as const;
export const planVisibilitySchema = z.enum(PLAN_VISIBILITIES);
export type PlanVisibility = z.infer<typeof planVisibilitySchema>;

export const PLAN_STATUSES = [
  'clarifying',
  'drafting',
  'reviewing',
  'sending',
  'sent',
  'archived',
] as const;
export const planStatusSchema = z.enum(PLAN_STATUSES);
export type PlanStatus = z.infer<typeof planStatusSchema>;

/** D10: how a feature's specification is published, per project. */
export const PLANNER_SPEC_OUTPUTS = ['docs_pr', 'issue_body'] as const;
export const plannerSpecOutputSchema = z.enum(PLANNER_SPEC_OUTPUTS);
export type PlannerSpecOutput = z.infer<typeof plannerSpecOutputSchema>;

// Tasks

/** D4. */
export const PLAN_TASK_KINDS = ['bug', 'feature'] as const;
export const planTaskKindSchema = z.enum(PLAN_TASK_KINDS);
export type PlanTaskKind = z.infer<typeof planTaskKindSchema>;

/** D6, D9: a task's state before and up to its issue. */
export const PLAN_TASK_STATUSES = [
  'draft',
  'needs_talk',
  'ready',
  'approved',
  'rejected',
  'rewrite_requested',
  'issued',
] as const;
export const planTaskStatusSchema = z.enum(PLAN_TASK_STATUSES);
export type PlanTaskStatus = z.infer<typeof planTaskStatusSchema>;

/**
 * An issued task's live status — derived on read from the issue cache, the
 * queue and the fleet, never stored (spec "Data / Schema").
 */
export const PLAN_TASK_LIVE_STATUSES = [
  'queued',
  'in_flight',
  'pr_open',
  'merged',
  'closed',
] as const;
export const planTaskLiveStatusSchema = z.enum(PLAN_TASK_LIVE_STATUSES);
export type PlanTaskLiveStatus = z.infer<typeof planTaskLiveStatusSchema>;

/**
 * A task's key, stable within a plan (`t3`). It appears in `dependsOn` and in
 * `Depends on <key>` lines of a document, so it is short and plain.
 */
export const planTaskKeySchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,31}$/, 'must match ^[a-z][a-z0-9-]{0,31}$');
export type PlanTaskKey = z.infer<typeof planTaskKeySchema>;

// Turns

/** D1, D16. */
export const PLAN_TURN_ACTIONS = [
  'decompose',
  'clarify',
  'grill',
  'write',
  'revise',
] as const;
export const planTurnActionSchema = z.enum(PLAN_TURN_ACTIONS);
export type PlanTurnAction = z.infer<typeof planTurnActionSchema>;

export const PLAN_TURN_PHASES = [
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
] as const;
export const planTurnPhaseSchema = z.enum(PLAN_TURN_PHASES);
export type PlanTurnPhase = z.infer<typeof planTurnPhaseSchema>;

// Questions and answers (D7)

const idSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/, 'must be a short id');

const text = (max: number) => z.string().trim().min(1).max(max);

export const planQuestionOptionSchema = z.strictObject({
  id: idSchema,
  label: text(PLANNER_TITLE_MAX),
  detail: text(PLANNER_QUESTION_MAX).optional(),
});
export type PlanQuestionOption = z.infer<typeof planQuestionOptionSchema>;

/** The option the planner would pick (`optionId`) or its free-text answer, and why. */
export const planRecommendationSchema = z.strictObject({
  optionId: idSchema.optional(),
  text: text(PLANNER_QUESTION_MAX),
  why: text(PLANNER_QUESTION_MAX),
});
export type PlanRecommendation = z.infer<typeof planRecommendationSchema>;

/**
 * D6, D7. `blocking`: no safe default — the task is `needs_talk` until it is
 * answered. A non-blocking question's recommendation is the default taken.
 */
export const planQuestionSchema = z
  .strictObject({
    id: idSchema,
    title: text(PLANNER_TITLE_MAX),
    question: text(PLANNER_QUESTION_MAX),
    options: z.array(planQuestionOptionSchema).max(PLANNER_MAX_OPTIONS),
    recommendation: planRecommendationSchema,
    blocking: z.boolean(),
  })
  .superRefine((q, ctx) => {
    const ids = q.options.map((o) => o.id);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['options'],
        message: 'option ids must be unique',
      });
    }
    const pick = q.recommendation.optionId;
    if (pick !== undefined && !ids.includes(pick)) {
      ctx.addIssue({
        code: 'custom',
        path: ['recommendation', 'optionId'],
        message: `names no option of this question: ${pick}`,
      });
    }
  });
export type PlanQuestion = z.infer<typeof planQuestionSchema>;

/** A round: at most `PLANNER_MAX_QUESTIONS`, ids unique within it. */
export const planQuestionRoundSchema = z
  .array(planQuestionSchema)
  .max(PLANNER_MAX_QUESTIONS)
  .refine((qs) => new Set(qs.map((q) => q.id)).size === qs.length, {
    message: 'question ids must be unique within a round',
  });

/** One answer of a round, in a turn's input: an option, words, or both. */
export const planAnswerSchema = z
  .strictObject({
    questionId: idSchema,
    optionId: idSchema.optional(),
    text: text(PLANNER_QUESTION_MAX).optional(),
  })
  .refine((a) => a.optionId !== undefined || a.text !== undefined, {
    message: 'an answer needs an optionId or text',
  });
export type PlanAnswer = z.infer<typeof planAnswerSchema>;

/** A turn's input as the API stores it (`plan_turns.input`). */
export const planTurnInputSchema = z.strictObject({
  message: text(PLANNER_SUMMARY_MAX).optional(),
  answers: z.array(planAnswerSchema).max(PLANNER_MAX_QUESTIONS).optional(),
});
export type PlanTurnInput = z.infer<typeof planTurnInputSchema>;

// Output contract (v1), one shape per action

export const plannedTaskSchema = z.strictObject({
  key: planTaskKeySchema,
  kind: planTaskKindSchema,
  title: text(PLANNER_TITLE_MAX),
  summary: text(PLANNER_SUMMARY_MAX),
  dependsOn: z.array(planTaskKeySchema).max(PLANNER_MAX_TASKS),
  questions: planQuestionRoundSchema,
});
export type PlannedTask = z.infer<typeof plannedTaskSchema>;

/** D9: a frozen (approved) task passes through a revise by its key alone. */
export const frozenTaskRefSchema = z.strictObject({ key: planTaskKeySchema });
export type FrozenTaskRef = z.infer<typeof frozenTaskRefSchema>;

export const clarifyOutputSchema = z.strictObject({
  action: z.literal('clarify'),
  questions: planQuestionRoundSchema,
  done: z.boolean(),
});
export type ClarifyOutput = z.infer<typeof clarifyOutputSchema>;

export const decomposeOutputSchema = z.strictObject({
  action: z.literal('decompose'),
  title: text(PLANNER_TITLE_MAX),
  tasks: z.array(plannedTaskSchema).min(1).max(PLANNER_MAX_TASKS),
});
export type DecomposeOutput = z.infer<typeof decomposeOutputSchema>;

export const grillOutputSchema = z.strictObject({
  action: z.literal('grill'),
  taskKey: planTaskKeySchema,
  questions: planQuestionRoundSchema,
  done: z.boolean(),
});
export type GrillOutput = z.infer<typeof grillOutputSchema>;

export const writeOutputSchema = z.strictObject({
  action: z.literal('write'),
  taskKey: planTaskKeySchema,
  document: text(PLANNER_DOCUMENT_MAX),
  assumptions: z.array(text(PLANNER_QUESTION_MAX)).max(PLANNER_ASSUMPTIONS_MAX),
});
export type WriteOutput = z.infer<typeof writeOutputSchema>;

export const reviseOutputSchema = z.strictObject({
  action: z.literal('revise'),
  tasks: z
    .array(z.union([plannedTaskSchema, frozenTaskRefSchema]))
    .min(1)
    .max(PLANNER_MAX_TASKS),
});
export type ReviseOutput = z.infer<typeof reviseOutputSchema>;

export const plannerOutputSchemas = {
  clarify: clarifyOutputSchema,
  decompose: decomposeOutputSchema,
  grill: grillOutputSchema,
  write: writeOutputSchema,
  revise: reviseOutputSchema,
} as const satisfies Record<PlanTurnAction, z.ZodType>;

export type PlannerOutput<A extends PlanTurnAction = PlanTurnAction> = z.infer<
  (typeof plannerOutputSchemas)[A]
>;

/** A task in a revise output that is new or changed, not a frozen pass-through. */
export const isPlannedTask = (
  task: PlannedTask | FrozenTaskRef,
): task is PlannedTask => 'kind' in task;

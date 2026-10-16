import { z } from 'zod';
import { attachmentIdSchema } from '../attachments/contracts';
import { ATTACHMENTS_PER_CARD_MAX } from '../attachments/limits';
import { DESIGN_RATIONALE_MAX, DESIGN_TITLE_MAX } from '../design/limits';
import { designSuggestionSchema, designVariantSchema } from '../design/types';
import { LOCAL_CARD_BODY_MAX } from '../protocol/local';

/**
 * The Planner (docs/specs/172-planner.md): plan, task, question and turn
 * types, and the output contract's shapes (v1, and v2 of
 * docs/specs/223-design-stage.md). The contract is code, not data
 * (ADR-0019): every object here is strict, so a key the contract does not
 * name is a violation, never a silently dropped field.
 */

/**
 * Bumped when the output shapes below change; each plan records the one it
 * ran with (D11) and keeps running under it. v2 adds design suggestions to
 * tasks and the `design` action (spec 223). v3 adds multiple-choice
 * questions and the card intake's `intake` action (#337 D3, D4).
 */
export const PLANNER_CONTRACT_VERSION = 3;
export const PLANNER_CONTRACT_VERSIONS = [1, 2, 3] as const;
export type PlannerContractVersion = (typeof PLANNER_CONTRACT_VERSIONS)[number];

/** A stored `plans.contractVersion` as a known version; an unknown one reads as the current. */
export const asPlannerContractVersion = (
  version: number,
): PlannerContractVersion =>
  (PLANNER_CONTRACT_VERSIONS as readonly number[]).includes(version)
    ? (version as PlannerContractVersion)
    : PLANNER_CONTRACT_VERSION;

/** The tag of the one fenced block a turn's final message must hold (D17). */
export const PLANNER_BLOCK_TAG = 'agentdock-plan';

/** Spec 223 D7: the tag of the one block holding a design turn's HTML. */
export const PLANNER_DESIGN_BLOCK_TAG = 'agentdock-design';

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

/**
 * #337 D4: question rounds a card intake may ask. After the last one, the
 * next turn must write the card (`intakeMustGenerate`).
 */
export const PLANNER_INTAKE_MAX_ROUNDS = 4;
/** #337 D6: a generated card's title. */
export const CARD_DRAFT_TITLE_MAX = 80;
/** #337 D6: a generated card's body — the board's card body limit. */
export const CARD_DRAFT_BODY_MAX = LOCAL_CARD_BODY_MAX;
/**
 * #409: the cards a split proposal names — at least two (one is a card), at
 * most as many as a round has questions.
 */
export const INTAKE_SPLIT_MIN = 2;
export const INTAKE_SPLIT_MAX = 8;
/** #409: a split card's one-line summary, and the proposal's reason. */
export const INTAKE_SPLIT_SUMMARY_MAX = 300;
export const INTAKE_SPLIT_REASON_MAX = 1000;
/** #337 D6: the `##` sections a generated card's body carries, in order. */
export const CARD_DRAFT_SECTIONS = [
  'What to do',
  'Acceptance criteria',
  'Out of scope',
  'Open questions',
] as const;

// Plans

/**
 * D2; `card` is #337 D1: a New work intake, ending in one card — or, after a
 * confirmed split, several independent ones (#409).
 */
export const PLAN_MODES = ['batch', 'dialogue', 'card'] as const;
export const planModeSchema = z.enum(PLAN_MODES);
export type PlanMode = z.infer<typeof planModeSchema>;

/** D12: private by default. */
export const PLAN_VISIBILITIES = ['private', 'project'] as const;
export const planVisibilitySchema = z.enum(PLAN_VISIBILITIES);
export type PlanVisibility = z.infer<typeof planVisibilitySchema>;

/**
 * `done` (#337 D6, D7): the plan made its board cards — an intake its one
 * card, a plan its Create cards. Like `sent`, it takes no more turns.
 */
export const PLAN_STATUSES = [
  'clarifying',
  'drafting',
  'reviewing',
  'sending',
  'sent',
  'archived',
  'done',
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

/**
 * D6, D9: a task's state before and up to its issue. `needs_design`: the
 * design is on and not approved yet (spec 223 D1).
 */
export const PLAN_TASK_STATUSES = [
  'draft',
  'needs_talk',
  'needs_design',
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

/**
 * D1, D16; `design` is spec 223 D7; `intake` is #337 D1 — every turn of a
 * `card` plan, which opens a round or writes the card.
 */
export const PLAN_TURN_ACTIONS = [
  'decompose',
  'clarify',
  'grill',
  'write',
  'revise',
  'design',
  'intake',
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
 * `multiple` (#337 D3, contract v3): checkboxes — the answer may pick several
 * options; absent is single choice. A free answer is always accepted.
 *
 * `multiple` is accepted under every contract version: only v3's text offers
 * it, so an older plan's model never writes it, and reading it back is safe.
 */
export const planQuestionSchema = z
  .strictObject({
    id: idSchema,
    title: text(PLANNER_TITLE_MAX),
    question: text(PLANNER_QUESTION_MAX),
    options: z.array(planQuestionOptionSchema).max(PLANNER_MAX_OPTIONS),
    multiple: z.boolean().optional(),
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

/**
 * One answer of a round, in a turn's input: an option, words, or both.
 * `optionIds` (#337 D3) picks several options of a `multiple` question; it
 * and `optionId` are never sent together. Whether the picks fit the question
 * is `checkRoundAnswers`'s, which needs the round.
 */
export const planAnswerSchema = z
  .strictObject({
    questionId: idSchema,
    optionId: idSchema.optional(),
    optionIds: z.array(idSchema).min(1).max(PLANNER_MAX_OPTIONS).optional(),
    text: text(PLANNER_QUESTION_MAX).optional(),
  })
  .refine(
    (a) =>
      a.optionId !== undefined ||
      a.optionIds !== undefined ||
      a.text !== undefined,
    { message: 'an answer needs an optionId, optionIds or text' },
  )
  .refine((a) => a.optionId === undefined || a.optionIds === undefined, {
    message: 'an answer has optionId or optionIds, not both',
  })
  .refine(
    (a) =>
      a.optionIds === undefined ||
      new Set(a.optionIds).size === a.optionIds.length,
    { path: ['optionIds'], message: 'optionIds must be unique' },
  );
export type PlanAnswer = z.infer<typeof planAnswerSchema>;

/**
 * A turn's input as the API stores it (`plan_turns.input`). #337: `generate`
 * is Enough — generate (D3): the turn must write the card; `attachmentIds`
 * are the files that came with it, passed to `plan.turn` (D10). #409:
 * `keepOne` is Keep one card — the person declined the split, and the turn
 * must write one card for the whole request.
 */
export const planTurnInputSchema = z.strictObject({
  message: text(PLANNER_SUMMARY_MAX).optional(),
  answers: z.array(planAnswerSchema).max(PLANNER_MAX_QUESTIONS).optional(),
  generate: z.boolean().optional(),
  keepOne: z.boolean().optional(),
  attachmentIds: z
    .array(attachmentIdSchema)
    .max(ATTACHMENTS_PER_CARD_MAX)
    .optional(),
});
export type PlanTurnInput = z.infer<typeof planTurnInputSchema>;

// Output contract, one shape per action
//
// Three families: v1 and v2 are what a turn is validated against, by its
// plan's `contractVersion`; the unsuffixed schemas read either back (a stored
// output of any version), so `design` is optional on them.

const plannedTaskShape = {
  key: planTaskKeySchema,
  kind: planTaskKindSchema,
  title: text(PLANNER_TITLE_MAX),
  summary: text(PLANNER_SUMMARY_MAX),
  dependsOn: z.array(planTaskKeySchema).max(PLANNER_MAX_TASKS),
  questions: planQuestionRoundSchema,
};

export const plannedTaskSchemaV1 = z.strictObject(plannedTaskShape);
/** Spec 223 D2: every task carries the planner's design suggestion. */
export const plannedTaskSchemaV2 = z.strictObject({
  ...plannedTaskShape,
  design: designSuggestionSchema,
});
/** A task of either version. */
export const plannedTaskSchema = z.strictObject({
  ...plannedTaskShape,
  design: designSuggestionSchema.optional(),
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

const decomposeOf = <T extends z.ZodType>(task: T) =>
  z.strictObject({
    action: z.literal('decompose'),
    title: text(PLANNER_TITLE_MAX),
    tasks: z.array(task).min(1).max(PLANNER_MAX_TASKS),
  });
export const decomposeOutputSchemaV1 = decomposeOf(plannedTaskSchemaV1);
export const decomposeOutputSchemaV2 = decomposeOf(plannedTaskSchemaV2);
export const decomposeOutputSchema = decomposeOf(plannedTaskSchema);
export type DecomposeOutput = z.infer<typeof decomposeOutputSchema>;

const grillShape = {
  action: z.literal('grill'),
  taskKey: planTaskKeySchema,
  questions: planQuestionRoundSchema,
  done: z.boolean(),
};
export const grillOutputSchemaV1 = z.strictObject(grillShape);
/** Spec 223: a grill may update the task's design suggestion. */
export const grillOutputSchema = z.strictObject({
  ...grillShape,
  design: designSuggestionSchema.optional(),
});
export const grillOutputSchemaV2 = grillOutputSchema;
export type GrillOutput = z.infer<typeof grillOutputSchema>;

export const writeOutputSchema = z.strictObject({
  action: z.literal('write'),
  taskKey: planTaskKeySchema,
  document: text(PLANNER_DOCUMENT_MAX),
  assumptions: z.array(text(PLANNER_QUESTION_MAX)).max(PLANNER_ASSUMPTIONS_MAX),
});
export type WriteOutput = z.infer<typeof writeOutputSchema>;

const reviseOf = <T extends z.ZodType>(task: T) =>
  z.strictObject({
    action: z.literal('revise'),
    tasks: z
      .array(z.union([task, frozenTaskRefSchema]))
      .min(1)
      .max(PLANNER_MAX_TASKS),
  });
export const reviseOutputSchemaV1 = reviseOf(plannedTaskSchemaV1);
export const reviseOutputSchemaV2 = reviseOf(plannedTaskSchemaV2);
export const reviseOutputSchema = reviseOf(plannedTaskSchema);
export type ReviseOutput = z.infer<typeof reviseOutputSchema>;

/**
 * Spec 223 D7: a design turn's plan block; the HTML travels in the one
 * `agentdock-design` block beside it. `addressed` lists the ids of the open
 * comments this revision answers (D10). The same shape under every contract
 * version: a v1 plan's design is switched on by hand.
 */
export const designOutputSchema = z.strictObject({
  action: z.literal('design'),
  taskKey: planTaskKeySchema,
  variant: designVariantSchema,
  title: text(DESIGN_TITLE_MAX),
  rationale: text(DESIGN_RATIONALE_MAX),
  addressed: z.array(z.string().min(1).max(64)).max(100),
});
export type DesignOutput = z.infer<typeof designOutputSchema>;

/**
 * #337 D6: the card an intake writes — English, whatever the person's
 * language (D5). The body carries the `CARD_DRAFT_SECTIONS`, checked by the
 * parser. It lands in Todo with `kindSource = auto`.
 */
export const cardDraftSchema = z.strictObject({
  title: text(CARD_DRAFT_TITLE_MAX),
  kind: planTaskKindSchema,
  body: text(CARD_DRAFT_BODY_MAX),
});
export type CardDraft = z.infer<typeof cardDraftSchema>;

/**
 * #337 D1, D4: a card intake's turn either opens a question round or writes
 * the card — never both, never neither. A round has at least one question.
 */
export const intakeRoundOutputSchema = z.strictObject({
  action: z.literal('intake'),
  questions: planQuestionRoundSchema.min(1),
});
export const intakeCardOutputSchema = z.strictObject({
  action: z.literal('intake'),
  cardDraft: cardDraftSchema,
});
/**
 * #409: one card of a split proposal — a full card, written like the single
 * one, and a one-line summary the person reads in the proposal.
 */
export const splitCardDraftSchema = z.strictObject({
  title: text(CARD_DRAFT_TITLE_MAX),
  kind: planTaskKindSchema,
  summary: text(INTAKE_SPLIT_SUMMARY_MAX),
  body: text(CARD_DRAFT_BODY_MAX),
});
export type SplitCardDraft = z.infer<typeof splitCardDraftSchema>;

/**
 * #409: the intake proposes several independent cards — the request was
 * several tasks, or one too big for one agent. Nothing is made until the
 * person confirms; they may decline and keep one card.
 */
export const intakeSplitOutputSchema = z.strictObject({
  action: z.literal('intake'),
  split: z.strictObject({
    reason: text(INTAKE_SPLIT_REASON_MAX),
    cards: z
      .array(splitCardDraftSchema)
      .min(INTAKE_SPLIT_MIN)
      .max(INTAKE_SPLIT_MAX),
  }),
});
export const intakeOutputSchema = z.union([
  intakeRoundOutputSchema,
  intakeCardOutputSchema,
  intakeSplitOutputSchema,
]);
export type IntakeOutput = z.infer<typeof intakeOutputSchema>;
export type IntakeRoundOutput = z.infer<typeof intakeRoundOutputSchema>;
export type IntakeCardOutput = z.infer<typeof intakeCardOutputSchema>;
export type IntakeSplitOutput = z.infer<typeof intakeSplitOutputSchema>;

/** An intake output that wrote the card. */
export const isIntakeCard = (
  output: IntakeOutput,
): output is IntakeCardOutput => 'cardDraft' in output;

/** #409: an intake output that proposed a split. */
export const isIntakeSplit = (
  output: IntakeOutput,
): output is IntakeSplitOutput => 'split' in output;

/** An intake output that opened a question round. */
export const isIntakeRound = (
  output: IntakeOutput,
): output is IntakeRoundOutput => 'questions' in output;

/**
 * What a v1 plan's turns are validated against. `intake` is listed under
 * every version only to keep the record total: a `card` plan is always v3
 * or later, and the API sends `intake` to `card` plans alone.
 */
export const plannerOutputSchemasV1 = {
  clarify: clarifyOutputSchema,
  decompose: decomposeOutputSchemaV1,
  grill: grillOutputSchemaV1,
  write: writeOutputSchema,
  revise: reviseOutputSchemaV1,
  design: designOutputSchema,
  intake: intakeOutputSchema,
} as const satisfies Record<PlanTurnAction, z.ZodType>;

/**
 * What a v2 and a v3 plan's turns are validated against: v3 changes the
 * text (multiple choice, the intake), not these shapes.
 */
export const plannerOutputSchemasV2 = {
  clarify: clarifyOutputSchema,
  decompose: decomposeOutputSchemaV2,
  grill: grillOutputSchemaV2,
  write: writeOutputSchema,
  revise: reviseOutputSchemaV2,
  design: designOutputSchema,
  intake: intakeOutputSchema,
} as const satisfies Record<PlanTurnAction, z.ZodType>;

/** The schemas a turn of a plan of `version` is validated against. */
export const plannerOutputSchemasFor = (version: PlannerContractVersion) =>
  version === 1 ? plannerOutputSchemasV1 : plannerOutputSchemasV2;

/** Reads a stored output of any version back (`plan_turns.output`). */
export const plannerOutputSchemas = {
  clarify: clarifyOutputSchema,
  decompose: decomposeOutputSchema,
  grill: grillOutputSchema,
  write: writeOutputSchema,
  revise: reviseOutputSchema,
  design: designOutputSchema,
  intake: intakeOutputSchema,
} as const satisfies Record<PlanTurnAction, z.ZodType>;

export type PlannerOutput<A extends PlanTurnAction = PlanTurnAction> = z.infer<
  (typeof plannerOutputSchemas)[A]
>;

/** A task in a revise output that is new or changed, not a frozen pass-through. */
export const isPlannedTask = (
  task: PlannedTask | FrozenTaskRef,
): task is PlannedTask => 'kind' in task;

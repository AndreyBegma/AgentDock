import {
  ACCEPT_CANDIDATES_AS,
  ACCEPT_CANDIDATES_MAX,
  type AcceptCandidateRef,
  type AcceptCandidatesAs,
  type AcceptCandidatesRequest,
  ATTACHMENTS_PER_CARD_MAX,
  CARD_DRAFT_BODY_MAX,
  CARD_DRAFT_TITLE_MAX,
  type ConfirmSplitCard,
  type ConfirmSplitRequest,
  type ConfirmStackRequest,
  type CreatePlanRequest,
  DISCUSS_SKILLS_MAX,
  INTAKE_SPLIT_MAX,
  PLAN_MODES,
  PLAN_REVIEW_DECISIONS,
  PLAN_TASK_KINDS,
  PLAN_TASK_LIVE_STATUSES,
  PLAN_TASK_STATUSES,
  PLAN_VISIBILITIES,
  PLANNER_MAX_OPTIONS,
  PLANNER_MAX_QUESTIONS,
  PLANNER_QUESTION_MAX,
  PLANNER_SPEC_OUTPUTS,
  PLANNER_SUMMARY_MAX,
  type PlanMode,
  type PlannerInstructionsUpdateRequest,
  type PlannerSettingsUpdateRequest,
  type PlannerSpecOutput,
  type PlanReviewDecision,
  type PlanTaskKind,
  type PlanTaskLiveStatus,
  type PlanTaskReviewRequest,
  type PlanTaskStatus,
  type PlanVisibility,
  type PlanVisibilityRequest,
  STACK_BODY_MAX,
  STACK_STAGE_TITLE_MAX,
  STACK_TITLE_MAX,
  type TasksQuery,
  type UpdatePlanCandidateRequest,
} from '@agentdock/shared';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

/**
 * Shapes only. The shared zod schemas (`planTurnInputSchema`, the protocol's
 * `plannerCommands`) are the full rule and are applied again before anything
 * is stored or sent.
 */
const ID_MAX_LENGTH = 64;
/** A brief is free text; the whole prompt stays under 256 KiB (D16). */
export const BRIEF_MAX_LENGTH = 20_000;
/** An instructions version; the prompt cap bounds it in practice. */
export const INSTRUCTIONS_MAX_LENGTH = 64_000;
/** `orchestratorModelSchema`: never a flag. */
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]*$/;
/** `profileKeySchema`. */
const PROFILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** The planner's short ids (questions, options). */
const SHORT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
/** `attachmentIdSchema`. */
const ATTACHMENT_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** A skill invocation, as the design skills take it. */
const SKILL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const SKILL_MAX_LENGTH = 128;

/** `POST /projects/:projectId/plans`. */
export class CreatePlanDto implements CreatePlanRequest {
  @IsString()
  @IsNotEmpty()
  @MaxLength(BRIEF_MAX_LENGTH)
  brief!: string;

  @IsIn(PLAN_MODES)
  mode!: PlanMode;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  @Matches(MODEL_PATTERN, { message: 'model must be a model alias or id' })
  model?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  @Matches(PROFILE_PATTERN, { message: 'profileKey must be a profile id' })
  profileKey?: string;

  /** #337 D10: pending uploads the intake claims. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(ATTACHMENTS_PER_CARD_MAX)
  @IsString({ each: true })
  @Matches(ATTACHMENT_ID, {
    each: true,
    message: 'attachmentIds must be attachment ids',
  })
  attachmentIds?: string[];

  /** #590: a discussion's installed skills. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(DISCUSS_SKILLS_MAX)
  @IsString({ each: true })
  @MaxLength(SKILL_MAX_LENGTH, { each: true })
  @Matches(SKILL_PATTERN, {
    each: true,
    message: 'each skill must be an installed skill invocation',
  })
  skills?: string[];
}

export class PlanAnswerDto {
  @IsString()
  @Matches(SHORT_ID, { message: 'questionId must be a question id' })
  questionId!: string;

  @IsOptional()
  @IsString()
  @Matches(SHORT_ID, { message: 'optionId must be an option id' })
  optionId?: string;

  /** #337 D3: the picks of a `multiple` question. */
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(PLANNER_MAX_OPTIONS)
  @IsString({ each: true })
  @Matches(SHORT_ID, {
    each: true,
    message: 'optionIds must be option ids',
  })
  optionIds?: string[];

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(PLANNER_QUESTION_MAX)
  text?: string;
}

/** Both turn routes: a chat message, a round's answers, or both (D7). */
export class PlanTurnDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(PLANNER_SUMMARY_MAX)
  message?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(PLANNER_MAX_QUESTIONS)
  @ValidateNested({ each: true })
  @Type(() => PlanAnswerDto)
  answers?: PlanAnswerDto[];

  /** #337 D3: Enough — generate. */
  @IsOptional()
  @IsBoolean()
  generate?: boolean;

  /** #409: Keep one card — the person declined the split. */
  @IsOptional()
  @IsBoolean()
  keepOne?: boolean;

  /** #337 D10: files that came with the answer. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(ATTACHMENTS_PER_CARD_MAX)
  @IsString({ each: true })
  @Matches(ATTACHMENT_ID, {
    each: true,
    message: 'attachmentIds must be attachment ids',
  })
  attachmentIds?: string[];
}

/** One kept card of a confirmed split (#409). */
export class ConfirmSplitCardDto implements ConfirmSplitCard {
  @IsInt()
  @Min(0)
  @Max(INTAKE_SPLIT_MAX - 1)
  index!: number;

  @IsString()
  @IsNotEmpty()
  @MaxLength(CARD_DRAFT_TITLE_MAX)
  title!: string;

  @IsIn(PLAN_TASK_KINDS)
  kind!: PlanTaskKind;
}

/** #480: one stage of a confirmed stack — its cards by proposal index. */
export class ConfirmStackStageDto {
  @IsString()
  @MaxLength(STACK_STAGE_TITLE_MAX)
  title!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(INTAKE_SPLIT_MAX)
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(INTAKE_SPLIT_MAX - 1, { each: true })
  cards!: number[];
}

/** #480 (ADR-0044): Confirm the cards as a stack. */
export class ConfirmStackDto implements ConfirmStackRequest {
  @IsString()
  @IsNotEmpty()
  @MaxLength(STACK_TITLE_MAX)
  title!: string;

  @IsString()
  @MaxLength(STACK_BODY_MAX)
  body!: string;

  @IsBoolean()
  design!: boolean;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(INTAKE_SPLIT_MAX)
  @ValidateNested({ each: true })
  @Type(() => ConfirmStackStageDto)
  stages!: ConfirmStackStageDto[];
}

/** `POST …/plans/:planId/split` (#409): Confirm a split. */
export class ConfirmSplitDto implements ConfirmSplitRequest {
  @IsString()
  @IsNotEmpty()
  @MaxLength(ID_MAX_LENGTH)
  turnId!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(INTAKE_SPLIT_MAX)
  @ValidateNested({ each: true })
  @Type(() => ConfirmSplitCardDto)
  cards!: ConfirmSplitCardDto[];

  /** #480: confirm them as a stack. */
  @IsOptional()
  @ValidateNested()
  @Type(() => ConfirmStackDto)
  stack?: ConfirmStackDto;
}

/** `PATCH …/plans/:planId/candidates/:candidateId` (#592): an edit by hand. */
export class UpdatePlanCandidateDto implements UpdatePlanCandidateRequest {
  @IsInt()
  @Min(1)
  version!: number;

  @IsOptional()
  @IsString()
  @MaxLength(CARD_DRAFT_TITLE_MAX)
  title?: string;

  @IsOptional()
  @IsIn(PLAN_TASK_KINDS)
  kind?: PlanTaskKind;

  @IsOptional()
  @IsString()
  @MaxLength(CARD_DRAFT_BODY_MAX)
  body?: string;
}

/** #592: one candidate of an accept, at the version the person saw. */
export class AcceptCandidateRefDto implements AcceptCandidateRef {
  @IsString()
  @IsNotEmpty()
  @MaxLength(ID_MAX_LENGTH)
  id!: string;

  @IsInt()
  @Min(1)
  version!: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(ACCEPT_CANDIDATES_MAX - 1)
  stage?: number;
}

/** `POST /projects/:projectId/candidates/accept` (#592, ADR-0057 §3). */
export class AcceptCandidatesDto implements AcceptCandidatesRequest {
  @IsIn(ACCEPT_CANDIDATES_AS)
  as!: AcceptCandidatesAs;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(ACCEPT_CANDIDATES_MAX)
  @ValidateNested({ each: true })
  @Type(() => AcceptCandidateRefDto)
  candidates!: AcceptCandidateRefDto[];
}

/** `POST …/tasks/:key/review`. */
export class PlanTaskReviewDto implements PlanTaskReviewRequest {
  @IsIn(PLAN_REVIEW_DECISIONS)
  decision!: PlanReviewDecision;

  @IsOptional()
  @IsString()
  @MaxLength(PLANNER_SUMMARY_MAX)
  comment?: string;
}

/** `POST …/visibility`. */
export class PlanVisibilityDto implements PlanVisibilityRequest {
  @IsIn(PLAN_VISIBILITIES)
  visibility!: PlanVisibility;
}

/** `PUT /admin/planner/instructions`. */
export class PlannerInstructionsDto
  implements PlannerInstructionsUpdateRequest
{
  @IsString()
  @Matches(/\S/, { message: 'body must not be blank' })
  @MaxLength(INSTRUCTIONS_MAX_LENGTH)
  body!: string;
}

/** `PUT /projects/:projectId/planner/settings`. A blank override clears it. */
export class PlannerSettingsDto implements PlannerSettingsUpdateRequest {
  @IsIn(PLANNER_SPEC_OUTPUTS)
  specOutput!: PlannerSpecOutput;

  @IsOptional()
  @IsString()
  @MaxLength(INSTRUCTIONS_MAX_LENGTH)
  instructionsOverride?: string;
}

const TASK_FILTER_STATUSES = [
  ...PLAN_TASK_STATUSES,
  ...PLAN_TASK_LIVE_STATUSES,
] as const;

/** `GET /tasks`. */
export class TasksQueryDto implements TasksQuery {
  @IsOptional()
  @IsString()
  @MaxLength(ID_MAX_LENGTH)
  projectId?: string;

  @IsOptional()
  @IsIn(PLAN_TASK_KINDS)
  kind?: PlanTaskKind;

  @IsOptional()
  @IsIn(TASK_FILTER_STATUSES)
  status?: PlanTaskStatus | PlanTaskLiveStatus;

  @IsOptional()
  @IsString()
  @MaxLength(ID_MAX_LENGTH)
  planId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  cursor?: string;
}

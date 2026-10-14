import {
  type CreatePlanRequest,
  PLAN_MODES,
  PLAN_REVIEW_DECISIONS,
  PLAN_TASK_KINDS,
  PLAN_TASK_LIVE_STATUSES,
  PLAN_TASK_STATUSES,
  PLAN_VISIBILITIES,
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
  type TasksQuery,
} from '@agentdock/shared';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
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
}

export class PlanAnswerDto {
  @IsString()
  @Matches(SHORT_ID, { message: 'questionId must be a question id' })
  questionId!: string;

  @IsOptional()
  @IsString()
  @Matches(SHORT_ID, { message: 'optionId must be an option id' })
  optionId?: string;

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

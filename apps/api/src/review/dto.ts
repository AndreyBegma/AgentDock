import {
  type CreateReviewStepRequest,
  REVIEW_INSTRUCTIONS_MAX,
  REVIEW_SKILL_NAME_MAX,
  REVIEW_STEP_NAME_MAX,
  REVIEW_STEPS_MAX,
  type ReorderReviewStepsRequest,
  type UpdateReviewSettingsRequest,
  type UpdateReviewStepRequest,
} from '@nautelle/shared';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

const ID_MAX_LENGTH = 64;

/** Surrounding whitespace never counts: `'  '` is an empty name. */
const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/** `PUT /projects/:id/review`. */
export class UpdateReviewSettingsDto implements UpdateReviewSettingsRequest {
  @IsOptional()
  @IsBoolean()
  reviewEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  publishReviewComments?: boolean;
}

/** `POST /projects/:id/review/steps`: a skill step. */
export class CreateReviewStepDto implements CreateReviewStepRequest {
  @IsString()
  @Transform(trim)
  @IsNotEmpty()
  @MaxLength(REVIEW_STEP_NAME_MAX)
  name!: string;

  @IsString()
  @Transform(trim)
  @IsNotEmpty()
  @MaxLength(REVIEW_SKILL_NAME_MAX)
  skillName!: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

/**
 * `PATCH /projects/:id/review/steps/:stepId` — only the fields given change.
 * `instructions` is not trimmed: it is stored exactly as the person wrote it.
 */
export class UpdateReviewStepDto implements UpdateReviewStepRequest {
  @IsOptional()
  @IsString()
  @Transform(trim)
  @IsNotEmpty()
  @MaxLength(REVIEW_STEP_NAME_MAX)
  name?: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(REVIEW_INSTRUCTIONS_MAX)
  instructions?: string;

  @IsOptional()
  @IsString()
  @Transform(trim)
  @IsNotEmpty()
  @MaxLength(REVIEW_SKILL_NAME_MAX)
  skillName?: string;
}

/** `PUT /projects/:id/review/steps/order`. */
export class ReorderReviewStepsDto implements ReorderReviewStepsRequest {
  @IsArray()
  @ArrayMaxSize(REVIEW_STEPS_MAX)
  @ArrayUnique()
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  @MaxLength(ID_MAX_LENGTH, { each: true })
  stepIds!: string[];
}

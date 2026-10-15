import {
  type AcceptBoardCardRequest,
  type AcceptSuggestionRequest,
  BOARD_CARD_BODY_MAX,
  BOARD_CARD_KINDS,
  BOARD_CARD_TITLE_MAX,
  BOARD_COLUMNS,
  BOARD_MAX_RUNNING_MAX,
  BOARD_MAX_RUNNING_MIN,
  type BoardCardKind,
  type BoardColumn,
  CAPTURE_MODELS,
  CARD_FEEDBACK_MAX,
  type CaptureModel,
  type CardFeedbackRequest,
  type CreateBoardCardRequest,
  type MoveBoardCardRequest,
  type RunBoardCardRequest,
  type UpdateBoardCardRequest,
  type UpdateBoardSettingsRequest,
} from '@agentdock/shared';
import {
  type OrchestratorPermissionMode,
  orchestratorPermissionModeSchema,
} from '@agentdock/shared/protocol';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { AttachmentIds } from '../attachments/dto';

/** `orchestratorModelSchema`: never a flag. */
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]*$/;
const MODEL_MAX_LENGTH = 100;

/** `GET /board`. */
export class BoardQueryDto {
  /** Completed paging: the `completedAt` of the last card already shown. */
  @IsOptional()
  @IsISO8601({ strict: true })
  completedBefore?: string;
}

/** `POST /board/cards`. */
export class CreateBoardCardDto implements CreateBoardCardRequest {
  @IsString()
  @Matches(/\S/, { message: 'title must not be blank' })
  @MaxLength(BOARD_CARD_TITLE_MAX)
  title!: string;

  @IsOptional()
  @IsString()
  @MaxLength(BOARD_CARD_BODY_MAX)
  body?: string;

  @IsOptional()
  @IsIn(BOARD_CARD_KINDS)
  kind?: BoardCardKind;

  @IsOptional()
  @IsBoolean()
  issueOnRun?: boolean;

  @IsOptional()
  @IsBoolean()
  specOnRun?: boolean;

  /** #309 D3: pending uploads claimed onto the new card. */
  @IsOptional()
  @AttachmentIds()
  attachmentIds?: string[];
}

/** `PATCH /board/cards/:number`. `model: null` clears the override. */
export class UpdateBoardCardDto implements UpdateBoardCardRequest {
  @IsOptional()
  @IsString()
  @Matches(/\S/, { message: 'title must not be blank' })
  @MaxLength(BOARD_CARD_TITLE_MAX)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(BOARD_CARD_BODY_MAX)
  body?: string;

  @IsOptional()
  @IsIn(BOARD_CARD_KINDS)
  kind?: BoardCardKind;

  @IsOptional()
  @IsBoolean()
  issueOnRun?: boolean;

  @IsOptional()
  @IsBoolean()
  specOnRun?: boolean;

  @ValidateIf((dto: UpdateBoardCardDto) => dto.model !== null)
  @IsOptional()
  @IsString()
  @MaxLength(MODEL_MAX_LENGTH)
  @Matches(MODEL_PATTERN, { message: 'model is not a model name' })
  model?: string | null;

  /** #243 D5: refused with `design_approved` once the design is approved. */
  @IsOptional()
  @IsBoolean()
  continueAfterDesign?: boolean;

  /** #282 D3: a `terminal` card only; any other is refused `not_tracked`. */
  @IsOptional()
  @IsBoolean()
  autoCollect?: boolean;
}

/** `POST /board/cards/:number/move` (D7). */
export class MoveBoardCardDto implements MoveBoardCardRequest {
  @IsIn(BOARD_COLUMNS)
  column!: BoardColumn;

  @IsInt()
  @Min(0)
  @Max(1_000_000)
  index!: number;

  @IsOptional()
  @IsBoolean()
  stopWorker?: boolean;
}

/** `POST /board/cards/:number/run`. */
export class RunBoardCardDto implements RunBoardCardRequest {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(MODEL_MAX_LENGTH)
  @Matches(MODEL_PATTERN, { message: 'model is not a model name' })
  model?: string;

  @IsOptional()
  @IsIn(orchestratorPermissionModeSchema.options)
  permissionMode?: OrchestratorPermissionMode;
}

/** `POST /board/cards/:number/feedback` (D9). */
export class CardFeedbackDto implements CardFeedbackRequest {
  @IsString()
  @Matches(/\S/, { message: 'text must not be blank' })
  @MaxLength(CARD_FEEDBACK_MAX)
  text!: string;

  /** #309 D3: pending uploads claimed onto the card and the new round. */
  @IsOptional()
  @AttachmentIds()
  attachmentIds?: string[];
}

/** `PUT /board-settings`. */
export class UpdateBoardSettingsDto implements UpdateBoardSettingsRequest {
  @IsBoolean()
  issueOnRun!: boolean;

  @IsBoolean()
  specOnRun!: boolean;

  @IsInt()
  @Min(BOARD_MAX_RUNNING_MIN)
  @Max(BOARD_MAX_RUNNING_MAX)
  maxRunning!: number;

  /** #244 D10: `true` needs the project's session content on. */
  @IsOptional()
  @IsBoolean()
  captureEnabled?: boolean;

  @IsOptional()
  @IsIn(CAPTURE_MODELS)
  captureModel?: CaptureModel;

  /** #282 D3: the `autoCollect` a new terminal card starts with. */
  @IsOptional()
  @IsBoolean()
  autoCollectTracked?: boolean;
}

/** #273 D13: the head the person saw in the accept dialog. */
export class AcceptMergeDto {
  @IsString()
  @Matches(/^[0-9a-f]{40}$/, { message: 'headSha must be 40 lower-case hex' })
  headSha!: string;

  /** #329 D7: delete the PR's head branch on GitHub after the merge. */
  @IsOptional()
  @IsBoolean()
  deleteBranch?: boolean;
}

/** #329 D8: Accept without merging, closing the card's PR. */
export class AcceptClosePrDto {
  @IsBoolean()
  deleteBranch!: boolean;

  @IsBoolean()
  closeIssue!: boolean;
}

/**
 * `POST /board/cards/:number/accept` (#273 D13): no `merge` and no `closePr`
 * moves only (D14). `merge` with `closePr` is refused with 400 (#329).
 */
export class AcceptBoardCardDto implements AcceptBoardCardRequest {
  @IsOptional()
  @ValidateNested()
  @Type(() => AcceptMergeDto)
  merge?: AcceptMergeDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => AcceptClosePrDto)
  closePr?: AcceptClosePrDto;
}

/** `POST /board/cards/:number/accept-suggestion` (#244 D9): Edit & accept. */
export class AcceptSuggestionDto implements AcceptSuggestionRequest {
  @IsOptional()
  @IsString()
  @Matches(/\S/, { message: 'title must not be blank' })
  @MaxLength(BOARD_CARD_TITLE_MAX)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(BOARD_CARD_BODY_MAX)
  body?: string;

  @IsOptional()
  @IsIn(BOARD_CARD_KINDS)
  kind?: BoardCardKind;
}

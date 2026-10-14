import {
  BOARD_CARD_BODY_MAX,
  BOARD_CARD_KINDS,
  BOARD_CARD_TITLE_MAX,
  BOARD_COLUMNS,
  BOARD_MAX_RUNNING_MAX,
  BOARD_MAX_RUNNING_MIN,
  type BoardCardKind,
  type BoardColumn,
  CARD_FEEDBACK_MAX,
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
} from 'class-validator';

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
}

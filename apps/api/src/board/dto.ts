import {
  type AcceptBoardCardRequest,
  type AcceptSuggestionRequest,
  type AddCardDependencyRequest,
  type AddStackCardRequest,
  BOARD_CARD_BODY_MAX,
  BOARD_CARD_KINDS,
  BOARD_CARD_TITLE_MAX,
  BOARD_COLUMNS,
  BOARD_MAX_RUNNING_MAX,
  BOARD_MAX_RUNNING_MIN,
  type BoardCardKind,
  type BoardColumn,
  BULK_CARD_ACTIONS,
  BULK_CARDS_MAX,
  type BulkBoardCardsRequest,
  type BulkCardAction,
  CAPTURE_MODELS,
  CARD_BACKGROUND_STALL_MINUTES_MAX,
  CARD_BACKGROUND_STALL_MINUTES_MIN,
  CARD_EFFORTS,
  CARD_FEEDBACK_MAX,
  CARD_MERGE_POLICIES,
  type CaptureModel,
  type CardEffort,
  type CardFeedbackRequest,
  type CardMergePolicy,
  type CreateBoardCardRequest,
  type CreateBoardStackRequest,
  DESIGN_TEMPLATE_KEY_MAX,
  DESIGN_TEMPLATE_KEY_PATTERN,
  INTAKE_SPLIT_MAX,
  MANUAL_STACK_CARDS_MIN,
  type MoveBoardCardRequest,
  type RunBoardCardRequest,
  STACK_BODY_MAX,
  STACK_STAGE_TITLE_MAX,
  STACK_TITLE_MAX,
  type StackStageTitle,
  type UpdateBoardCardRequest,
  type UpdateBoardSettingsRequest,
  type UpdateBoardStackRequest,
} from '@nautelle/shared';
import {
  type OrchestratorPermissionMode,
  orchestratorPermissionModeSchema,
} from '@nautelle/shared/protocol';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
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
/** `profileKeySchema`. */
const PROFILE_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const PROFILE_KEY_MAX_LENGTH = 64;

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
  @Matches(/^[^\r\n]*$/, { message: 'title must be one line' })
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
  @Matches(/^[^\r\n]*$/, { message: 'title must be one line' })
  @MaxLength(BOARD_CARD_TITLE_MAX)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(BOARD_CARD_BODY_MAX)
  body?: string;

  @IsOptional()
  @IsIn(BOARD_CARD_KINDS)
  kind?: BoardCardKind;

  /** #833 D8: checked against the project's templates by the service. */
  @IsOptional()
  @IsString()
  @MaxLength(DESIGN_TEMPLATE_KEY_MAX)
  @Matches(DESIGN_TEMPLATE_KEY_PATTERN, {
    message: 'designTemplate is not a template key',
  })
  designTemplate?: string;

  @IsOptional()
  @IsBoolean()
  issueOnRun?: boolean;

  @IsOptional()
  @IsBoolean()
  specOnRun?: boolean;

  /**
   * #447 D8: links the card to an open issue of the project's repository —
   * its Run then creates none; `null` unlinks.
   */
  @ValidateIf((dto: UpdateBoardCardDto) => dto.issueNumber !== null)
  @IsOptional()
  @IsInt()
  @Min(1)
  issueNumber?: number | null;

  @ValidateIf((dto: UpdateBoardCardDto) => dto.model !== null)
  @IsOptional()
  @IsString()
  @MaxLength(MODEL_MAX_LENGTH)
  @Matches(MODEL_PATTERN, { message: 'model is not a model name' })
  model?: string | null;

  /** #322 D3: `null` clears the design model override. */
  @ValidateIf((dto: UpdateBoardCardDto) => dto.designModel !== null)
  @IsOptional()
  @IsString()
  @MaxLength(MODEL_MAX_LENGTH)
  @Matches(MODEL_PATTERN, { message: 'designModel is not a model name' })
  designModel?: string | null;

  /** #322 D3: `null` clears the profile override. */
  @ValidateIf((dto: UpdateBoardCardDto) => dto.profileKey !== null)
  @IsOptional()
  @IsString()
  @MaxLength(PROFILE_KEY_MAX_LENGTH)
  @Matches(PROFILE_KEY_PATTERN, { message: 'profileKey must be a profile id' })
  profileKey?: string | null;

  /** #243 D5: refused with `design_approved` once the design is approved. */
  @IsOptional()
  @IsBoolean()
  continueAfterDesign?: boolean;

  /** #282 D3: a `terminal` card only; any other is refused `not_tracked`. */
  @IsOptional()
  @IsBoolean()
  autoCollect?: boolean;

  /** #443: turning it on outside To Do is refused `wrong_column`. */
  @IsOptional()
  @IsBoolean()
  autoRunWhenReady?: boolean;
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

  /** #847: as on Accept — a move to Completed leaves unlanded work out. */
  @IsOptional()
  @IsBoolean()
  confirmUnlanded?: boolean;
}

/** `POST /board/cards/bulk` (#452): distinct card numbers, one action. */
export class BulkBoardCardsDto implements BulkBoardCardsRequest {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(BULK_CARDS_MAX)
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(999_999_999, { each: true })
  numbers!: number[];

  @IsIn(BULK_CARD_ACTIONS)
  action!: BulkCardAction;
}

/** `POST /board/cards/:number/run`. */
export class RunBoardCardDto implements RunBoardCardRequest {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(MODEL_MAX_LENGTH)
  @Matches(MODEL_PATTERN, { message: 'model is not a model name' })
  model?: string;

  /** #322 D9: the resolver refuses an unknown or non-Claude key (422 `no_profile`). */
  @IsOptional()
  @IsString()
  @MaxLength(PROFILE_KEY_MAX_LENGTH)
  @Matches(PROFILE_KEY_PATTERN, { message: 'profileKey must be a profile id' })
  profileKey?: string;

  /** #663: the work effort, remembered like `model`. */
  @IsOptional()
  @IsIn(CARD_EFFORTS)
  effort?: CardEffort;

  @IsOptional()
  @IsIn(orchestratorPermissionModeSchema.options)
  permissionMode?: OrchestratorPermissionMode;
}

/** `POST /board/cards/:number/dependencies` (#337 D8). */
export class AddCardDependencyDto implements AddCardDependencyRequest {
  @IsInt()
  @Min(1)
  @Max(999_999_999)
  dependsOn!: number;
}

/** C-377: one stage's new title in `PATCH /board/stacks/:number`. */
export class StackStageTitleDto implements StackStageTitle {
  /** 0-based. */
  @IsInt()
  @Min(0)
  @Max(INTAKE_SPLIT_MAX)
  position!: number;

  /** Empty clears it: the stage is called "Stage N". */
  @IsString()
  @Matches(/^[^\r\n]*$/, { message: 'stage title must be one line' })
  @MaxLength(STACK_STAGE_TITLE_MAX)
  title!: string;
}

/** `PATCH /board/stacks/:number` (#480); stage titles since C-377. */
export class UpdateBoardStackDto implements UpdateBoardStackRequest {
  @IsOptional()
  @IsString()
  @Matches(/\S/, { message: 'title must not be blank' })
  @Matches(/^[^\r\n]*$/, { message: 'title must be one line' })
  @MaxLength(STACK_TITLE_MAX)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(STACK_BODY_MAX)
  body?: string;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(INTAKE_SPLIT_MAX + 1)
  @ValidateNested({ each: true })
  @Type(() => StackStageTitleDto)
  stages?: StackStageTitleDto[];
}

/** `POST /board/stacks` (#588): cards grouped by hand into one stage. */
export class CreateBoardStackDto implements CreateBoardStackRequest {
  @IsString()
  @Matches(/\S/, { message: 'title must not be blank' })
  @Matches(/^[^\r\n]*$/, { message: 'title must be one line' })
  @MaxLength(STACK_TITLE_MAX)
  title!: string;

  @IsOptional()
  @IsString()
  @MaxLength(STACK_BODY_MAX)
  body?: string;

  @IsOptional()
  @IsBoolean()
  design?: boolean;

  @IsArray()
  @ArrayMinSize(MANUAL_STACK_CARDS_MIN)
  @ArrayMaxSize(BULK_CARDS_MAX)
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(999_999_999, { each: true })
  cards!: number[];
}

/** `POST /board/stacks/:number/cards` (#480). */
export class AddStackCardDto implements AddStackCardRequest {
  @IsInt()
  @Min(1)
  @Max(999_999_999)
  card!: number;

  /** 0-based; the number of stages adds a new last stage. */
  @IsInt()
  @Min(0)
  @Max(INTAKE_SPLIT_MAX)
  stage!: number;
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

  /** #359 D7: `null` returns to the default (on unless the base is main). */
  @ValidateIf((dto: UpdateBoardSettingsDto) => dto.autoMergeCards !== null)
  @IsOptional()
  @IsBoolean()
  autoMergeCards?: boolean | null;

  /** #390: minutes in `background` before `card.background_stalled`. */
  @IsOptional()
  @IsInt()
  @Min(CARD_BACKGROUND_STALL_MINUTES_MIN)
  @Max(CARD_BACKGROUND_STALL_MINUTES_MAX)
  backgroundStallMinutes?: number;

  /** #845 D4: who merges a finished card's pull request. */
  @IsOptional()
  @IsIn(CARD_MERGE_POLICIES)
  cardMergePolicy?: CardMergePolicy;
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

  @IsOptional()
  @IsBoolean()
  confirmUnlanded?: boolean;
}

/** `POST /board/cards/:number/accept-suggestion` (#244 D9): Edit & accept. */
export class AcceptSuggestionDto implements AcceptSuggestionRequest {
  @IsOptional()
  @IsString()
  @Matches(/\S/, { message: 'title must not be blank' })
  @Matches(/^[^\r\n]*$/, { message: 'title must be one line' })
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

import {
  BOARD_ASK_CHECKS,
  BOARD_ASK_PR_STATES,
  BOARD_ASK_QUESTION_MAX,
  BOARD_ASK_SOURCES,
  BOARD_CARD_KINDS,
  BOARD_COLUMNS,
  type BoardAskChecks,
  type BoardAskPrState,
  type BoardAskQuery,
  type BoardAskRequest,
  type BoardAskSource,
  type BoardCardKind,
  type BoardColumn,
  type BoardSearchRequest,
  TRIAGE_HINTS,
  type TriageHint,
  type TriageHintRequest,
} from '@nautelle/shared';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { ASK_TEXT_WORDS_MAX, ASK_WITHIN_DAYS_MAX } from './ask-query';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/** `POST /board/ask`. */
export class BoardAskDto implements BoardAskRequest {
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(BOARD_ASK_QUESTION_MAX)
  question!: string;
}

/** `POST …/triage/dismiss` and `…/triage/apply`. */
export class TriageHintDto implements TriageHintRequest {
  @IsIn(TRIAGE_HINTS)
  hint!: TriageHint;
}

/** The query of `POST /board/search`: every value one the search knows. */
export class BoardAskQueryDto implements BoardAskQuery {
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @MaxLength(200, { each: true })
  projects!: string[];

  @IsArray()
  @ArrayMaxSize(ASK_TEXT_WORDS_MAX)
  @IsString({ each: true })
  @MinLength(1, { each: true })
  @MaxLength(100, { each: true })
  text!: string[];

  @IsArray()
  @IsIn(BOARD_COLUMNS, { each: true })
  columns!: BoardColumn[];

  @IsOptional()
  @IsIn(BOARD_CARD_KINDS)
  kind!: BoardCardKind | null;

  @IsOptional()
  @IsIn(BOARD_ASK_PR_STATES)
  prState!: BoardAskPrState | null;

  @IsOptional()
  @IsIn(BOARD_ASK_CHECKS)
  checks!: BoardAskChecks | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(ASK_WITHIN_DAYS_MAX)
  withinDays!: number | null;

  @IsArray()
  @ArrayMinSize(1)
  @IsIn(BOARD_ASK_SOURCES, { each: true })
  sources!: BoardAskSource[];
}

/** `POST /board/search`. */
export class BoardSearchDto implements BoardSearchRequest {
  @ValidateNested()
  @Type(() => BoardAskQueryDto)
  query!: BoardAskQueryDto;
}

import {
  BOARD_CARD_KINDS,
  type BoardCardKind,
  WORK_QUERY_TEXT_MAX,
  WORK_SOURCES,
  WORK_STATUSES,
  type WorkQuery,
  type WorkSource,
  type WorkStatus,
} from '@nautelle/shared';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

const ID_MAX_LENGTH = 64;

/** `GET /work` (issue #270 D10). */
export class WorkQueryDto implements WorkQuery {
  @IsOptional()
  @IsString()
  @MaxLength(ID_MAX_LENGTH)
  projectId?: string;

  @IsOptional()
  @IsIn(WORK_SOURCES)
  source?: WorkSource;

  @IsOptional()
  @IsIn(BOARD_CARD_KINDS)
  kind?: BoardCardKind;

  @IsOptional()
  @IsIn(WORK_STATUSES)
  status?: WorkStatus;

  @IsOptional()
  @IsString()
  @MaxLength(WORK_QUERY_TEXT_MAX)
  q?: string;

  @IsOptional()
  @IsString()
  @MaxLength(ID_MAX_LENGTH)
  planId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  cursor?: string;
}

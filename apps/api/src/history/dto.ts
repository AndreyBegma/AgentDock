import {
  RUN_KINDS,
  RUN_PAGE_MAX,
  RUN_STATUSES,
  type RunKind,
  type RunListQuery,
  type RunStatus,
} from '@agentdock/shared';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { CURSOR_PATTERN } from '../activity';

/** `GET /projects/:projectId/runs` (spec 21 "API"). */
export class RunListQueryDto implements RunListQuery {
  @IsOptional()
  @IsIn(RUN_KINDS)
  kind?: RunKind;

  @IsOptional()
  @IsIn(RUN_STATUSES)
  status?: RunStatus;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  issue?: number;

  @IsOptional()
  @IsISO8601()
  from?: string;

  @IsOptional()
  @IsISO8601()
  to?: string;

  @IsOptional()
  @Matches(CURSOR_PATTERN)
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(RUN_PAGE_MAX)
  limit?: number;
}

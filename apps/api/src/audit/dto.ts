import {
  AUDIT_PAGE_MAX,
  AUDIT_RESULTS,
  type AuditFilters,
  type AuditResult,
} from '@agentdock/shared';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/** A `seq` as it travels over HTTP: a positive decimal BigInt. */
export const SEQ_PATTERN = /^[1-9]\d{0,18}$/;

/** Filters of the list and the CSV export (spec "API"). */
export class AuditFiltersQuery implements AuditFilters {
  @IsOptional()
  @IsISO8601()
  from?: string;

  @IsOptional()
  @IsISO8601()
  to?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  action?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  actorUserId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  targetType?: string;

  @IsOptional()
  @IsString()
  @MaxLength(320)
  targetId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  projectId?: string;

  @IsOptional()
  @IsIn(AUDIT_RESULTS)
  result?: AuditResult;
}

export class ListAuditQuery extends AuditFiltersQuery {
  /** `nextCursor` of the previous page: records with a lower `seq` follow. */
  @IsOptional()
  @Matches(SEQ_PATTERN)
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(AUDIT_PAGE_MAX)
  limit?: number;
}

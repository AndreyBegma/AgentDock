import {
  AUDIT_PAGE_MAX,
  AUDIT_RESULTS,
  type AuditFilters,
  type AuditResult,
} from '@nautelle/shared';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateBy,
} from 'class-validator';
import { parsePositiveBigInt } from '../common/pipes';

/** A `seq` as it travels over HTTP: a decimal BigInt in 1..2^63-1. */
const IsSeq = () =>
  ValidateBy({
    name: 'isSeq',
    validator: {
      validate: (value: unknown) =>
        typeof value === 'string' && parsePositiveBigInt(value) !== null,
      defaultMessage: (args) =>
        `${args?.property ?? 'seq'} must be an integer from 1 to 2^63-1`,
    },
  });

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
  @IsSeq()
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(AUDIT_PAGE_MAX)
  limit?: number;
}

import {
  USAGE_BREAKDOWN_MAX_LIMIT,
  USAGE_DIMENSIONS,
  USAGE_GROUP_BY,
  USAGE_INTERVALS,
  type UsageBreakdownQuery,
  type UsageDimension,
  type UsageGroupBy,
  type UsageInterval,
  type UsageRangeQuery,
  type UsageTimeseriesQuery,
} from '@agentdock/shared';
import { Transform, Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  isISO8601,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/** An ISO 8601 string as `…Z`; anything else is left for `IsISO8601` to refuse. */
const toUtcIso = ({ value }: { value: unknown }) =>
  typeof value === 'string' && isISO8601(value, { strict: true })
    ? new Date(value).toISOString()
    : value;

export class UsageRangeDto implements UsageRangeQuery {
  @IsISO8601({ strict: true })
  @Transform(toUtcIso)
  from!: string;

  @IsISO8601({ strict: true })
  @Transform(toUtcIso)
  to!: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  projectId?: string;
}

export class UsageTimeseriesDto
  extends UsageRangeDto
  implements UsageTimeseriesQuery
{
  @IsOptional()
  @IsIn(USAGE_INTERVALS)
  interval?: UsageInterval;

  @IsOptional()
  @IsIn(USAGE_GROUP_BY)
  groupBy?: UsageGroupBy;

  /** Checked against the runtime's time zone list by the service. */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  tz?: string;
}

export class UsageBreakdownDto
  extends UsageRangeDto
  implements UsageBreakdownQuery
{
  @IsIn(USAGE_DIMENSIONS)
  dimension!: UsageDimension;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(USAGE_BREAKDOWN_MAX_LIMIT)
  limit?: number;
}

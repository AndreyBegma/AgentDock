import {
  ACTIVITY_CATEGORIES,
  ACTIVITY_PAGE_MAX,
  type ActivityCategory,
  type ActivityQuery,
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

/** A base64url keyset cursor (keyset.ts). */
export const CURSOR_PATTERN = /^[A-Za-z0-9_-]{1,200}$/;

/** `GET /projects/:projectId/activity` (spec 21 "API"). */
export class ProjectActivityQuery implements Omit<ActivityQuery, 'projectId'> {
  @IsOptional()
  @IsIn(ACTIVITY_CATEGORIES)
  category?: ActivityCategory;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  type?: string;

  /** An actor id: a user's or a runner's. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  actor?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  slot?: string;

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
  @Max(ACTIVITY_PAGE_MAX)
  limit?: number;
}

/** `GET /activity`: the same filters, across the caller's projects. */
export class ActivityListQuery
  extends ProjectActivityQuery
  implements ActivityQuery
{
  @IsOptional()
  @IsString()
  @MaxLength(200)
  projectId?: string;
}

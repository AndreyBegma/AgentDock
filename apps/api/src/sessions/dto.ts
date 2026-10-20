import {
  type BackfillRequest,
  SESSION_LIST_MAX_LIMIT,
  SESSION_ORIGINS,
  type SessionListQuery,
  type SessionOrigin,
} from '@nautelle/shared';
import {
  type Runtime,
  runtimeSchema,
  SESSION_ID_MAX_LENGTH,
  SESSION_NAME_MAX_LENGTH,
} from '@nautelle/shared/protocol';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  isISO8601,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/** An ISO 8601 string as `…Z`; anything else is left for `IsISO8601` to refuse. */
const toUtcIso = ({ value }: { value: unknown }) =>
  typeof value === 'string' && isISO8601(value, { strict: true })
    ? new Date(value).toISOString()
    : value;

/** `POST /admin/runners/:id/backfill` — the `session.backfill` args (D11). */
export class BackfillDto implements BackfillRequest {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(SESSION_ID_MAX_LENGTH)
  projectId?: string;

  /**
   * Only transcripts modified after it are re-read. Any ISO 8601 date-time is
   * accepted and sent in UTC, the form the command's schema takes.
   */
  @IsISO8601({ strict: true })
  @Transform(toUtcIso)
  since!: string;
}

/** `true`/`false` in a query string; anything else is left for `IsBoolean` to refuse. */
const queryBoolean = ({ value }: { value: unknown }) =>
  value === 'true' ? true : value === 'false' ? false : value;

export class ListSessionsQuery implements SessionListQuery {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  projectId?: string;

  @IsOptional()
  @IsIn(runtimeSchema.options)
  runtime?: Runtime;

  @IsOptional()
  @IsIn(SESSION_ORIGINS)
  origin?: SessionOrigin;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(SESSION_NAME_MAX_LENGTH)
  model?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(SESSION_NAME_MAX_LENGTH)
  slot?: string;

  @IsOptional()
  @IsISO8601()
  from?: string;

  @IsOptional()
  @IsISO8601()
  to?: string;

  @IsOptional()
  @Transform(queryBoolean)
  @IsBoolean()
  unassigned?: boolean;

  /** `nextCursor` of the previous page: a session id. */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(SESSION_ID_MAX_LENGTH)
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(SESSION_LIST_MAX_LIMIT)
  limit?: number;
}

/** `GET projects/:projectId/sessions/:id/content` — `nextCursor` is a content row id. */
export class SessionContentQuery {
  @IsOptional()
  @IsString()
  @Matches(/^\d{1,18}$/, { message: 'cursor must be a content row id' })
  cursor?: string;
}

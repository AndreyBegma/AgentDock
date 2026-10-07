import {
  SESSION_LIST_MAX_LIMIT,
  type SessionListQuery,
} from '@agentdock/shared';
import {
  type Runtime,
  runtimeSchema,
  SESSION_ID_MAX_LENGTH,
  SESSION_NAME_MAX_LENGTH,
} from '@agentdock/shared/protocol';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

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

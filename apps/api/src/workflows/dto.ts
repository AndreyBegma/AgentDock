import {
  WORKFLOW_AGENT_TYPE_MAX_LENGTH,
  WORKFLOW_COMPACTION_BUCKETS,
  WORKFLOW_OUTCOMES,
  WORKFLOW_STATUSES,
  WORKFLOW_TOOLS_MAX_LIMIT,
  type WorkflowCompactionBucket,
  type WorkflowOutcome,
  type WorkflowStatus,
  type WorkflowsQuery,
  type WorkflowsToolsQuery,
} from '@agentdock/shared';
import {
  type Runtime,
  runtimeSchema,
  SESSION_NAME_MAX_LENGTH,
} from '@agentdock/shared/protocol';
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

/** The query of every `/workflows` route (shared `WorkflowsQuery`). */
export class WorkflowsQueryDto implements WorkflowsQuery {
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

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(SESSION_NAME_MAX_LENGTH)
  profileKey?: string;

  @IsOptional()
  @IsIn(runtimeSchema.options)
  runtime?: Runtime;

  @IsOptional()
  @IsIn(WORKFLOW_STATUSES)
  status?: WorkflowStatus;

  @IsOptional()
  @IsIn(WORKFLOW_OUTCOMES)
  outcome?: WorkflowOutcome;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(WORKFLOW_AGENT_TYPE_MAX_LENGTH)
  agentType?: string;

  @IsOptional()
  @IsIn(WORKFLOW_COMPACTION_BUCKETS)
  compactions?: WorkflowCompactionBucket;
}

export class WorkflowsToolsQueryDto
  extends WorkflowsQueryDto
  implements WorkflowsToolsQuery
{
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(WORKFLOW_TOOLS_MAX_LIMIT)
  limit?: number;
}

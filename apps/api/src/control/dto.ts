import {
  COMMAND_RUN_LIST_MAX_LIMIT,
  type CommandRunListQuery,
  type OrchestratorSettingsRequest,
  type OrchestratorStartRequest,
  type SlotMessageRequest,
} from '@agentdock/shared';
import {
  type OrchestratorMode,
  type OrchestratorPermissionMode,
  orchestratorModeSchema,
  orchestratorPermissionModeSchema,
  SLOT_MESSAGE_MAX_BYTES,
} from '@agentdock/shared/protocol';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

/** The model rule of the protocol (`orchestratorModelSchema`): never a flag. */
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]*$/;
const MODEL_MAX_LENGTH = 100;
const ID_MAX_LENGTH = 64;

/** `POST /projects/:projectId/orchestrator/start`. */
export class OrchestratorStartDto implements OrchestratorStartRequest {
  @IsIn(orchestratorModeSchema.options)
  mode!: OrchestratorMode;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(ID_MAX_LENGTH)
  profileId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(MODEL_MAX_LENGTH)
  @Matches(MODEL_PATTERN, { message: 'model must be a model alias or id' })
  model?: string;

  @IsOptional()
  @IsIn(orchestratorPermissionModeSchema.options)
  permissionMode?: OrchestratorPermissionMode;
}

/** `PUT /projects/:projectId/orchestrator/settings` — only the fields sent change. */
export class OrchestratorSettingsDto implements OrchestratorSettingsRequest {
  /** `null` falls back to the project's default profile. */
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @IsNotEmpty()
  @MaxLength(ID_MAX_LENGTH)
  profileId?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(MODEL_MAX_LENGTH)
  @Matches(MODEL_PATTERN, { message: 'model must be a model alias or id' })
  model?: string;

  @IsOptional()
  @IsIn(orchestratorPermissionModeSchema.options)
  permissionMode?: OrchestratorPermissionMode;
}

/**
 * `POST /projects/:projectId/slots/:slot/message`. The byte limit and the
 * blank check are the command schema's, applied by the service.
 */
export class SlotMessageDto implements SlotMessageRequest {
  @IsString()
  @IsNotEmpty()
  @MaxLength(SLOT_MESSAGE_MAX_BYTES)
  text!: string;
}

export class CommandRunListQueryDto implements CommandRunListQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(COMMAND_RUN_LIST_MAX_LIMIT)
  limit?: number;

  /** `nextCursor` of the previous page: a run id. */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(ID_MAX_LENGTH)
  cursor?: string;
}

import {
  INBOUND_ALLOWED_PATHS_MAX,
  INBOUND_VALUE_PATTERN_MAX_CHARS,
  type InboundDryRunRequest,
  type InboundTriggerAction,
  type InboundTriggerCreateRequest,
  type InboundTriggerUpdateRequest,
} from '@agentdock/shared';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDefined,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  ValidateIf,
} from 'class-validator';

const NAME_MAX_LENGTH = 100;
const ID_MAX_LENGTH = 64;
const PATH_MAX_LENGTH = 700;

/**
 * `action` is D3's closed union and is checked by the shared schema, and
 * `allowedPaths` / `valuePattern` by D4's rules, so a bad one answers with
 * the webhooks error codes rather than a generic 400.
 */
export class TriggerCreateDto implements InboundTriggerCreateRequest {
  @IsString()
  @IsNotEmpty()
  @MaxLength(NAME_MAX_LENGTH)
  name!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(ID_MAX_LENGTH)
  projectId!: string;

  @IsObject()
  action!: InboundTriggerAction;

  @IsArray()
  @ArrayMaxSize(INBOUND_ALLOWED_PATHS_MAX)
  @IsString({ each: true })
  @MaxLength(PATH_MAX_LENGTH, { each: true })
  allowedPaths!: string[];

  /** Null or absent: the default pattern. */
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(INBOUND_VALUE_PATTERN_MAX_CHARS)
  valuePattern?: string | null;
}

/** `PATCH` — only the fields sent change; the project is fixed. */
export class TriggerUpdateDto implements InboundTriggerUpdateRequest {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(NAME_MAX_LENGTH)
  name?: string;

  @IsOptional()
  @IsObject()
  action?: InboundTriggerAction;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(INBOUND_ALLOWED_PATHS_MAX)
  @IsString({ each: true })
  @MaxLength(PATH_MAX_LENGTH, { each: true })
  allowedPaths?: string[];

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(INBOUND_VALUE_PATTERN_MAX_CHARS)
  valuePattern?: string | null;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

/** `POST /admin/triggers/:id/dry-run`: any JSON value as the payload. */
export class TriggerDryRunDto implements InboundDryRunRequest {
  @IsDefined()
  payload!: unknown;
}

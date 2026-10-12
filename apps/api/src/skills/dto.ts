import type {
  SkillInspectRequest,
  SkillInstallRequest,
  SkillRunRequest,
} from '@agentdock/shared';
import {
  type OrchestratorPermissionMode,
  orchestratorPermissionModeSchema,
  type Runtime,
  runtimeSchema,
  SKILL_RUN_ARGS_MAX_BYTES,
  SKILL_RUN_MAX_TIMEOUT_SEC,
  SKILL_RUN_MIN_TIMEOUT_SEC,
  SKILL_SEARCH_QUERY_MAX,
  type SkillRunOutput,
  skillRunOutputSchema,
} from '@agentdock/shared/protocol';
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
} from 'class-validator';

/**
 * Shapes only. The protocol's zod schemas (`skillCommands`) are the full rule
 * and are applied again before anything is sent, so a value that passes here
 * and fails there is a 400 `invalid_args` with nothing sent.
 */
const ID_MAX_LENGTH = 64;
/** `skillSourceSchema`: `owner/repo`, never a URL. */
const SOURCE_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_][A-Za-z0-9._-]*$/;
/** `skillNameSchema`. */
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** `skillInvocationSchema`. */
const INVOCATION_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._-]*(?::[A-Za-z0-9][A-Za-z0-9._-]*)?$/;
/** `gitRefSchema`'s first rule. */
const REF_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._/-]*$/;
/** `orchestratorModelSchema`: never a flag. */
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]*$/;

/** `GET /skills/catalog`. */
export class SkillCatalogQueryDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(SKILL_SEARCH_QUERY_MAX)
  q!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(ID_MAX_LENGTH)
  runnerId!: string;
}

/** `POST /skills/inspect`. */
export class SkillInspectDto implements SkillInspectRequest {
  @IsString()
  @IsNotEmpty()
  @MaxLength(ID_MAX_LENGTH)
  runnerId!: string;

  @IsString()
  @MaxLength(140)
  @Matches(SOURCE_PATTERN, { message: 'source must be owner/repo' })
  source!: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  @Matches(NAME_PATTERN, { message: 'skillId must be a skill name' })
  skillId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  @Matches(REF_PATTERN, { message: 'ref must be a branch or tag name' })
  ref?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(ID_MAX_LENGTH)
  projectId?: string;
}

/** Both install routes. */
export class SkillInstallDto implements SkillInstallRequest {
  @IsString()
  @IsNotEmpty()
  @MaxLength(ID_MAX_LENGTH)
  previewId!: string;

  @IsIn(runtimeSchema.options)
  runtime!: Runtime;
}

/** `POST /projects/:projectId/skill-runs`. */
export class SkillRunDto implements SkillRunRequest {
  @IsString()
  @MaxLength(129)
  @Matches(INVOCATION_PATTERN, {
    message: 'skill must be <name> or <plugin>:<name>',
  })
  skill!: string;

  /** Bytes are checked against `SKILL_RUN_ARGS_MAX_BYTES` by the protocol schema. */
  @IsString()
  @MaxLength(SKILL_RUN_ARGS_MAX_BYTES)
  args!: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  @Matches(NAME_PATTERN, { message: 'profileKey must be a profile id' })
  profileKey?: string;

  @IsString()
  @MaxLength(100)
  @Matches(MODEL_PATTERN, { message: 'model must be a model alias or id' })
  model!: string;

  @IsOptional()
  @IsIn(orchestratorPermissionModeSchema.options)
  permissionMode?: OrchestratorPermissionMode;

  @IsIn(skillRunOutputSchema.options)
  output!: SkillRunOutput;

  @IsOptional()
  @IsInt()
  @Min(SKILL_RUN_MIN_TIMEOUT_SEC)
  @Max(SKILL_RUN_MAX_TIMEOUT_SEC)
  timeoutSec?: number;
}

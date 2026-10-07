import {
  type AddProjectMemberRequest,
  type ConnectProjectRequest,
  type DocsSourceOverrideRequest,
  type InspectProjectRequest,
  PROJECT_BRANCH_MAX_LENGTH,
  PROJECT_DISPLAY_NAME_MAX_LENGTH,
  PROJECT_LABEL_MAX_LENGTH,
  PROJECT_PATH_MAX_LENGTH,
  ROLES,
  type Role,
  type UpdateProjectMemberRequest,
  type UpdateProjectRequest,
} from '@agentdock/shared';
import {
  type DocsSourceKind,
  docsSourceKindSchema,
} from '@agentdock/shared/protocol';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateIf,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

const ABSOLUTE_PATH = /^\//;
const REPO_NAME = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
/** A git ref name, loosely: no whitespace, `~^:?*[\` or `..`. */
const BRANCH = /^(?!.*\.\.)[^\s~^:?*[\\]+$/;

export class InspectProjectDto implements InspectProjectRequest {
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  runnerId!: string;

  @Transform(trim)
  @IsString()
  @MaxLength(PROJECT_PATH_MAX_LENGTH)
  @Matches(ABSOLUTE_PATH, { message: 'path must be absolute' })
  path!: string;
}

export class ConnectProjectDto
  extends InspectProjectDto
  implements ConnectProjectRequest
{
  @IsOptional()
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(PROJECT_DISPLAY_NAME_MAX_LENGTH)
  displayName?: string;
}

/** `null` on an optional field clears it; `undefined` leaves it alone. */
export class UpdateProjectDto implements UpdateProjectRequest {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(PROJECT_DISPLAY_NAME_MAX_LENGTH)
  displayName?: string;

  @ValidateIf((_, v) => v !== null && v !== undefined)
  @Transform(trim)
  @IsString()
  @MaxLength(PROJECT_BRANCH_MAX_LENGTH)
  @Matches(BRANCH, { message: 'baseOverride must be a branch name' })
  baseOverride?: string | null;

  @ValidateIf((_, v) => v !== null && v !== undefined)
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(PROJECT_LABEL_MAX_LENGTH)
  readyLabelOverride?: string | null;

  @ValidateIf((_, v) => v !== null && v !== undefined)
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  defaultProfileId?: string | null;

  @IsOptional()
  @IsBoolean()
  mergeApproval?: boolean;
}

/** Which fields a kind takes is checked by the service (`invalid_docs_source`). */
export class DocsSourceOverrideDto implements DocsSourceOverrideRequest {
  @IsIn(docsSourceKindSchema.options)
  kind!: DocsSourceKind;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(PROJECT_PATH_MAX_LENGTH)
  @Matches(ABSOLUTE_PATH, { message: 'localPath must be absolute' })
  localPath?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @Matches(REPO_NAME, { message: 'repo must be owner/name' })
  repo?: string;
}

export class AddProjectMemberDto implements AddProjectMemberRequest {
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  userId!: string;

  @ValidateIf((_, v) => v !== null && v !== undefined)
  @IsIn(ROLES)
  roleOverride?: Role | null;
}

export class UpdateProjectMemberDto implements UpdateProjectMemberRequest {
  @ValidateIf((_, v) => v !== null)
  @IsIn(ROLES)
  roleOverride!: Role | null;
}

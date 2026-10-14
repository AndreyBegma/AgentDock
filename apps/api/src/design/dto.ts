import {
  DESIGN_COMMENT_KINDS,
  DESIGN_COMMENT_MAX,
  DESIGN_SELECTOR_MAX,
  DESIGN_SKILLS_MAX,
  DESIGN_THEMES,
  DESIGN_VARIANTS_MAX,
  DESIGN_VARIANTS_MIN,
  DESIGN_VIEWPORT_MAX_PX,
  DESIGN_VIEWPORT_MIN_PX,
  DESIGN_VIEWPORT_NAME_MAX,
  DESIGN_VIEWPORTS_MAX,
  type DesignApproveRequest,
  type DesignCommentKind,
  type DesignCommentRequest,
  type DesignSettingsUpdateRequest,
  type DesignTheme,
  type TaskDesignPatchRequest,
  UI_PROFILE_KIT_MAX_BYTES,
  UI_PROFILE_SNIPPET_MAX_BYTES,
  UI_PROFILE_SNIPPET_NAME_MAX,
  UI_PROFILE_SNIPPETS_MAX,
  UI_PROFILE_SUMMARY_MAX,
  type UiProfileUpdateRequest,
  type ViewportPreset,
} from '@agentdock/shared';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

/**
 * Shapes only (docs/specs/223-design-stage.md "API"). The shared zod schemas
 * (`viewportPresetsSchema`, `uiProfileSnippetSchema`) are the full rule and
 * are applied again before anything is stored.
 */

const ID_MAX_LENGTH = 64;
/** A skill's invocation: `<name>` or `<plugin>:<name>` (#24 D8). */
const SKILL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const SKILL_MAX_LENGTH = 128;
/** A pin's point, as the helper reports it (`mockupMessageSchema`). */
const COORDINATE_MAX = 1_000_000;

/** `PATCH …/tasks/:key/design`. */
export class TaskDesignPatchDto implements TaskDesignPatchRequest {
  @IsOptional()
  @IsBoolean()
  needed?: boolean;

  @IsOptional()
  @IsInt()
  @Min(DESIGN_VARIANTS_MIN)
  @Max(DESIGN_VARIANTS_MAX)
  variantCount?: number;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(DESIGN_SKILLS_MAX)
  @IsString({ each: true })
  @MaxLength(SKILL_MAX_LENGTH, { each: true })
  @Matches(SKILL_PATTERN, {
    each: true,
    message: 'each skill must be an installed skill invocation',
  })
  skills?: string[];
}

/** `POST …/design/comments`. */
export class DesignCommentDto implements DesignCommentRequest {
  @IsString()
  @IsNotEmpty()
  @MaxLength(ID_MAX_LENGTH)
  revisionId!: string;

  @IsIn(DESIGN_COMMENT_KINDS)
  kind!: DesignCommentKind;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(DESIGN_VIEWPORT_NAME_MAX)
  viewport?: string;

  @IsOptional()
  @IsIn(DESIGN_THEMES)
  theme?: DesignTheme;

  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(COORDINATE_MAX)
  x?: number;

  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(COORDINATE_MAX)
  y?: number;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(DESIGN_SELECTOR_MAX)
  selector?: string;

  @IsString()
  @Matches(/\S/, { message: 'body must not be blank' })
  @MaxLength(DESIGN_COMMENT_MAX)
  body!: string;
}

/** `POST …/design/approve`. */
export class DesignApproveDto implements DesignApproveRequest {
  @IsString()
  @IsNotEmpty()
  @MaxLength(ID_MAX_LENGTH)
  revisionId!: string;
}

export class UiProfileSnippetDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(UI_PROFILE_SNIPPET_NAME_MAX)
  name!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(UI_PROFILE_SNIPPET_MAX_BYTES)
  html!: string;
}

/** `PUT /projects/:projectId/ui-profile`. */
export class UiProfileUpdateDto implements UiProfileUpdateRequest {
  @IsString()
  @Matches(/\S/, { message: 'summary must not be blank' })
  @MaxLength(UI_PROFILE_SUMMARY_MAX)
  summary!: string;

  @IsString()
  @MaxLength(UI_PROFILE_KIT_MAX_BYTES)
  kit!: string;

  @IsArray()
  @ArrayMaxSize(UI_PROFILE_SNIPPETS_MAX)
  @ValidateNested({ each: true })
  @Type(() => UiProfileSnippetDto)
  snippets!: UiProfileSnippetDto[];

  @IsOptional()
  @IsBoolean()
  hasUi?: boolean;
}

/** `GET /projects/:projectId/ui-profile/versions?version=`. */
export class UiProfileVersionsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  version?: number;
}

export class ViewportPresetDto implements ViewportPreset {
  @IsString()
  @IsNotEmpty()
  @MaxLength(DESIGN_VIEWPORT_NAME_MAX)
  name!: string;

  @IsInt()
  @Min(DESIGN_VIEWPORT_MIN_PX)
  @Max(DESIGN_VIEWPORT_MAX_PX)
  width!: number;

  @IsInt()
  @Min(DESIGN_VIEWPORT_MIN_PX)
  @Max(DESIGN_VIEWPORT_MAX_PX)
  height!: number;

  @IsOptional()
  @IsIn(DESIGN_THEMES)
  theme?: DesignTheme;
}

/** `PUT /projects/:projectId/design-settings`. */
export class DesignSettingsDto implements DesignSettingsUpdateRequest {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(DESIGN_VIEWPORTS_MAX)
  @ValidateNested({ each: true })
  @Type(() => ViewportPresetDto)
  viewports!: ViewportPresetDto[];

  @IsArray()
  @ArrayMaxSize(DESIGN_SKILLS_MAX)
  @IsString({ each: true })
  @MaxLength(SKILL_MAX_LENGTH, { each: true })
  @Matches(SKILL_PATTERN, {
    each: true,
    message: 'each skill must be an installed skill invocation',
  })
  defaultSkills!: string[];
}

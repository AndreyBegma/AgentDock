import {
  DEMO_SECRET_VALUE_MAX,
  DEMO_UI_PATH_MAX_LENGTH,
  DEMO_UI_PATHS_MAX,
  type PutDemoSecretRequest,
  type UpdateDemoSettingsRequest,
} from '@nautelle/shared';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

/** Surrounding whitespace never counts: `' apps/web/** '` is `apps/web/**`. */
const trimEach = ({ value }: { value: unknown }) =>
  Array.isArray(value)
    ? value.map((item: unknown) =>
        typeof item === 'string' ? item.trim() : item,
      )
    : value;

/** `PATCH /projects/:projectId/demos/settings`; an absent field is kept. */
export class UpdateDemoSettingsDto implements UpdateDemoSettingsRequest {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsArray()
  @Transform(trimEach)
  @ArrayMaxSize(DEMO_UI_PATHS_MAX)
  @ArrayUnique()
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  @MaxLength(DEMO_UI_PATH_MAX_LENGTH, { each: true })
  uiPaths?: string[];

  @IsOptional()
  @IsBoolean()
  telegram?: boolean;
}

/**
 * `PUT /projects/:projectId/demos/secrets/:name`. The value is not trimmed: a
 * password is stored exactly as it was typed.
 */
export class PutDemoSecretDto implements PutDemoSecretRequest {
  @IsString()
  @IsNotEmpty()
  @MaxLength(DEMO_SECRET_VALUE_MAX)
  value!: string;
}

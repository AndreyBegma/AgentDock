import {
  AI_DIGEST_TIME_PATTERN,
  type UpdateAiDigestSettings,
} from '@agentdock/shared';
import {
  IsBoolean,
  IsOptional,
  IsString,
  IsTimeZone,
  Matches,
  MaxLength,
} from 'class-validator';

/** IANA zone names are well under this. */
const ZONE_MAX_LENGTH = 64;

/** `PATCH /projects/:id/ai/digest/settings` (#658, project admin). */
export class UpdateAiDigestSettingsDto implements UpdateAiDigestSettings {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsString()
  @Matches(AI_DIGEST_TIME_PATTERN, { message: 'time must be HH:MM' })
  time?: string;

  @IsOptional()
  @IsString()
  @MaxLength(ZONE_MAX_LENGTH)
  @IsTimeZone({ message: 'timezone must be an IANA timezone' })
  timezone?: string;
}

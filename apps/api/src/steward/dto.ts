import {
  STEWARD_INCIDENT_STATUSES,
  STEWARD_SILENCE_MINUTES_MAX,
  STEWARD_SILENCE_MINUTES_MIN,
  type StewardIncidentStatus,
  type UpdateStewardSettingsBody,
} from '@agentdock/shared';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  isISO8601,
  Matches,
  Max,
  Min,
} from 'class-validator';

/** `stewardDigestTimeSchema` of the shared contract. */
const DIGEST_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** `PUT /projects/:id/steward` (#447 D16, project admin). */
export class UpdateStewardSettingsDto implements UpdateStewardSettingsBody {
  @IsBoolean()
  enabled!: boolean;

  @IsInt()
  @Min(STEWARD_SILENCE_MINUTES_MIN)
  @Max(STEWARD_SILENCE_MINUTES_MAX)
  silenceMinutes!: number;

  @Matches(DIGEST_TIME, { message: 'digestTime must be HH:MM' })
  digestTime!: string;

  @IsBoolean()
  autoNudge!: boolean;

  @IsBoolean()
  autoDismiss!: boolean;

  @IsBoolean()
  autoResume!: boolean;

  @IsBoolean()
  trailerGuard!: boolean;
}

/** An ISO 8601 string as `…Z`; anything else is left for `IsISO8601` to refuse. */
const toUtcIso = ({ value }: { value: unknown }) =>
  typeof value === 'string' && isISO8601(value, { strict: true })
    ? new Date(value).toISOString()
    : value;

/** `GET /projects/:id/steward/incidents?status&from&to&card`. */
export class StewardIncidentsQueryDto {
  @IsOptional()
  @IsIn(STEWARD_INCIDENT_STATUSES)
  status?: StewardIncidentStatus;

  @IsOptional()
  @IsISO8601({ strict: true })
  @Transform(toUtcIso)
  from?: string;

  @IsOptional()
  @IsISO8601({ strict: true })
  @Transform(toUtcIso)
  to?: string;

  /** The card sheet's Steward section: the incidents of the card's rounds. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  card?: number;
}

import {
  TECHNIQUE_MODES,
  type TechniqueMode,
  type TokenEconomySettingsBody,
  type TokenEconomyTechniqueBody,
} from '@nautelle/shared';
import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsISO8601, isISO8601, Max, Min } from 'class-validator';

/** `PUT /projects/:id/token-economy/settings` (#746, project admin). */
export class UpdateTokenEconomySettingsDto implements TokenEconomySettingsBody {
  @IsInt()
  @Min(0)
  @Max(100)
  bSharePercent!: number;
}

/** `PUT /projects/:id/token-economy/techniques/:technique` (#746 D5, D9). */
export class UpdateTokenEconomyTechniqueDto
  implements TokenEconomyTechniqueBody
{
  @IsIn(TECHNIQUE_MODES)
  mode!: TechniqueMode;
}

/** An ISO 8601 string as `…Z`; anything else is left for `IsISO8601` to refuse. */
const toUtcIso = ({ value }: { value: unknown }) =>
  typeof value === 'string' && isISO8601(value, { strict: true })
    ? new Date(value).toISOString()
    : value;

/** `GET /projects/:id/token-economy/report?from&to`. */
export class TokenEconomyReportQueryDto {
  @IsISO8601({ strict: true })
  @Transform(toUtcIso)
  from!: string;

  @IsISO8601({ strict: true })
  @Transform(toUtcIso)
  to!: string;
}

import {
  TOKEN_SAVER_MCP_ALLOW_MAX,
  type UpdateTokenSaverSettingsBody,
} from '@nautelle/shared';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsISO8601,
  isISO8601,
  Matches,
} from 'class-validator';

/** `mcpServerNameSchema` of the shared contract. */
const MCP_SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

/** `PUT /projects/:id/token-saver` (#445 D11, project admin). */
export class UpdateTokenSaverSettingsDto
  implements UpdateTokenSaverSettingsBody
{
  @IsBoolean()
  enabled!: boolean;

  @IsArray()
  @ArrayMaxSize(TOKEN_SAVER_MCP_ALLOW_MAX)
  @ArrayUnique()
  @Matches(MCP_SERVER_NAME, {
    each: true,
    message: 'each of mcpAllow must be an MCP server name',
  })
  mcpAllow!: string[];
}

/** An ISO 8601 string as `…Z`; anything else is left for `IsISO8601` to refuse. */
const toUtcIso = ({ value }: { value: unknown }) =>
  typeof value === 'string' && isISO8601(value, { strict: true })
    ? new Date(value).toISOString()
    : value;

/** `GET /projects/:id/token-saver/summary?from&to`. */
export class TokenSaverSummaryQueryDto {
  @IsISO8601({ strict: true })
  @Transform(toUtcIso)
  from!: string;

  @IsISO8601({ strict: true })
  @Transform(toUtcIso)
  to!: string;
}

import {
  type FileOverlayPart,
  type ProposePrefixOverlayBody,
} from '@nautelle/shared';
import { Transform } from 'class-transformer';
import { IsISO8601, IsString, isISO8601, Matches } from 'class-validator';

/** `fileOverlayPartSchema` of the shared contract. */
const FILE_OVERLAY_PART = /^(claude_md|skill:[A-Za-z0-9][A-Za-z0-9._-]{0,63})$/;

/** An ISO 8601 string as `…Z`; anything else is left for `IsISO8601` to refuse. */
const toUtcIso = ({ value }: { value: unknown }) =>
  typeof value === 'string' && isISO8601(value, { strict: true })
    ? new Date(value).toISOString()
    : value;

/** `GET /projects/:id/token-saver/prefix?from&to`. */
export class PrefixSummaryQueryDto {
  @IsISO8601({ strict: true })
  @Transform(toUtcIso)
  from!: string;

  @IsISO8601({ strict: true })
  @Transform(toUtcIso)
  to!: string;
}

/** `POST /projects/:id/prefix/overlays/propose` (admin). */
export class ProposePrefixOverlayDto implements ProposePrefixOverlayBody {
  @IsString()
  @Matches(FILE_OVERLAY_PART, {
    message: 'part must be claude_md or skill:<name>',
  })
  part!: FileOverlayPart;
}

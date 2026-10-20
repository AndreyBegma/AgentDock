import {
  type CreateRunnerRequest,
  type RenameRunnerRequest,
  RUNNER_NAME_MAX_LENGTH,
  type UpdateRunnerSettingsRequest,
} from '@nautelle/shared';
import type { PairingRequest } from '@nautelle/shared/protocol';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
  ValidateIf,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class CreateRunnerDto implements CreateRunnerRequest {
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(RUNNER_NAME_MAX_LENGTH)
  name!: string;
}

/**
 * `PATCH /admin/runners/:id`: the name, and spec 201's local user and away
 * mode. Only the fields sent change.
 */
export class UpdateRunnerDto
  implements Partial<RenameRunnerRequest>, UpdateRunnerSettingsRequest
{
  @IsOptional()
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(RUNNER_NAME_MAX_LENGTH)
  name?: string;

  /** `null` leaves the runner without a local user: local requests are refused. */
  @ValidateIf((_, value) => value !== null && value !== undefined)
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  localUserId?: string | null;

  @IsOptional()
  @IsBoolean()
  awayMode?: boolean;
}

/**
 * `PATCH /runners/:id` (spec 201 "API"): `localUserId` is an admin's, away
 * mode the admin's or the runner's local user's own.
 */
export class RunnerSettingsDto implements UpdateRunnerSettingsRequest {
  @ValidateIf((_, value) => value !== null && value !== undefined)
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  localUserId?: string | null;

  @IsOptional()
  @IsBoolean()
  awayMode?: boolean;
}

/**
 * `POST /runners/pair` (runner-protocol "Pairing"). The code's format is
 * checked by the service through the protocol's normaliser, so a malformed
 * code gets the same 400 `invalid_code` as a wrong one.
 */
export class PairRunnerDto implements Omit<PairingRequest, 'code'> {
  @IsString()
  @MaxLength(64)
  code!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  hostname!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  version!: string;

  @IsInt()
  @IsPositive()
  protocolVersion!: number;
}

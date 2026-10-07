import {
  type CreateRunnerRequest,
  type RenameRunnerRequest,
  RUNNER_NAME_MAX_LENGTH,
} from '@agentdock/shared';
import type { PairingRequest } from '@agentdock/shared/protocol';
import { Transform } from 'class-transformer';
import {
  IsInt,
  IsNotEmpty,
  IsPositive,
  IsString,
  MaxLength,
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

export class RenameRunnerDto implements RenameRunnerRequest {
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(RUNNER_NAME_MAX_LENGTH)
  name!: string;
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

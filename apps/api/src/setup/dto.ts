import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  type SetupAdminRequest,
} from '@nautelle/shared';
import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsOptional,
  IsString,
  Length,
  MaxLength,
} from 'class-validator';
import { normalizeEmail } from '../auth/dto';

const trim = (value: unknown): unknown =>
  typeof value === 'string' ? value.trim() : value;

/** The same account rules as `createAdmin` and registration. */
export class SetupAdminDto implements SetupAdminRequest {
  // Checked by the controller, so a missing token is a 403 like a wrong one.
  @IsOptional()
  @IsString()
  @MaxLength(128)
  token!: string;

  @Transform(({ value }) => normalizeEmail(value))
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @IsString()
  @Length(PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH)
  password!: string;

  @IsOptional()
  @Transform(({ value }) => trim(value))
  @IsString()
  @MaxLength(100)
  name?: string;
}

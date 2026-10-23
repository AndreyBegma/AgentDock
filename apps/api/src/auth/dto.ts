import {
  type ChangePasswordRequest,
  type LoginRequest,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  type RegisterRequest,
  type TwoFactorConfirmRequest,
  type TwoFactorEnableRequest,
  type TwoFactorPolicy,
  type TwoFactorSetupRequest,
} from '@nautelle/shared';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  Length,
  MaxLength,
} from 'class-validator';

export const normalizeEmail = (value: unknown): unknown =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

const trim = (value: unknown): unknown =>
  typeof value === 'string' ? value.trim() : value;

/** C-189: a TOTP code or a recovery code with its dashes; spaces are dropped. */
const CODE_MAX_LENGTH = 64;
const compact = (value: unknown): unknown =>
  typeof value === 'string' ? value.replace(/\s/g, '') : value;

export class RegisterDto implements RegisterRequest {
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

export class LoginDto implements LoginRequest {
  @Transform(({ value }) => normalizeEmail(value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(254)
  email!: string;

  // No length policy at login: a wrong-length password is just a wrong password.
  @IsString()
  @IsNotEmpty()
  @MaxLength(PASSWORD_MAX_LENGTH)
  password!: string;

  @IsOptional()
  @Transform(({ value }) => compact(value))
  @IsString()
  @MaxLength(CODE_MAX_LENGTH)
  code?: string;
}

export class ChangePasswordDto implements ChangePasswordRequest {
  @IsString()
  @IsNotEmpty()
  @MaxLength(PASSWORD_MAX_LENGTH)
  currentPassword!: string;

  @IsString()
  @Length(PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH)
  newPassword!: string;
}

export class TwoFactorSetupDto implements TwoFactorSetupRequest {
  @IsString()
  @IsNotEmpty()
  @MaxLength(PASSWORD_MAX_LENGTH)
  password!: string;
}

export class TwoFactorEnableDto implements TwoFactorEnableRequest {
  @Transform(({ value }) => compact(value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(CODE_MAX_LENGTH)
  code!: string;
}

export class TwoFactorConfirmDto implements TwoFactorConfirmRequest {
  @IsString()
  @IsNotEmpty()
  @MaxLength(PASSWORD_MAX_LENGTH)
  password!: string;

  @Transform(({ value }) => compact(value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(CODE_MAX_LENGTH)
  code!: string;
}

export class TwoFactorPolicyDto implements TwoFactorPolicy {
  @IsBoolean()
  requiredForAdmins!: boolean;
}

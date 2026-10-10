import {
  GITHUB_LOGIN_PATTERN,
  type GitHubAppCredentialsRequest,
  type GitHubManifestRequest,
} from '@agentdock/shared';
import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/** A 4096-bit RSA PEM is ~3.3 KB; this leaves room for any sane key. */
const PEM_MAX_LENGTH = 16_384;
const SECRET_MAX_LENGTH = 1024;
const SLUG_MAX_LENGTH = 100;
const CODE_MAX_LENGTH = 200;

/** `POST /admin/github-app/manifest`. */
export class GitHubManifestDto implements GitHubManifestRequest {
  @IsOptional()
  @IsString()
  @Matches(GITHUB_LOGIN_PATTERN, { message: 'owner must be a GitHub login' })
  owner?: string;
}

/** `GET /admin/github-app/callback?code=&state=` (D1). */
export class GitHubCallbackQuery {
  @IsString()
  @IsNotEmpty()
  @MaxLength(CODE_MAX_LENGTH)
  @Matches(/^[A-Za-z0-9_-]+$/, { message: 'code is malformed' })
  code!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(CODE_MAX_LENGTH)
  state!: string;
}

/** `PUT /admin/github-app` (D1 fallback). */
export class GitHubAppCredentialsDto implements GitHubAppCredentialsRequest {
  @IsInt()
  @Min(1)
  @Max(2_147_483_647)
  appId!: number;

  @IsString()
  @IsNotEmpty()
  @MaxLength(SLUG_MAX_LENGTH)
  @Matches(/^[a-z0-9][a-z0-9-]*$/, {
    message: 'slug must be a GitHub App slug',
  })
  slug!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(PEM_MAX_LENGTH)
  privateKey!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(SECRET_MAX_LENGTH)
  webhookSecret!: string;
}

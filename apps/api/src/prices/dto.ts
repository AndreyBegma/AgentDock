import {
  CONDITION_OPS,
  CONDITION_SUBJECTS,
  type ConditionOp,
  type ConditionSubject,
  type CreatePriceVersionRequest,
  type ModelPriceInput,
  type PriceTestRequest,
  type PriceTier,
  type RecomputeRequest,
  type TierCondition,
  type TierPrices,
} from '@agentdock/shared';
import type { TokenBuckets } from '@agentdock/shared/protocol';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  isISO8601,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

/** A non-negative decimal: USD per token, e.g. `0.000003`. */
const PRICE = /^\d{1,6}(\.\d{1,18})?$/;
const PRICE_MESSAGE = 'must be a non-negative decimal string';

const MAX_TOKENS = 1_000_000_000;

/** An ISO 8601 string as `…Z`; anything else is left for `IsISO8601` to refuse. */
const toUtcIso = ({ value }: { value: unknown }) =>
  typeof value === 'string' && isISO8601(value, { strict: true })
    ? new Date(value).toISOString()
    : value;

export class TierConditionDto implements TierCondition {
  @IsIn(CONDITION_SUBJECTS)
  bucket!: ConditionSubject;

  @IsIn(CONDITION_OPS)
  op!: ConditionOp;

  @IsInt()
  @Min(0)
  @Max(MAX_TOKENS)
  value!: number;
}

export class TierPricesDto implements TierPrices {
  @Matches(PRICE, { message: PRICE_MESSAGE })
  input!: string;

  @Matches(PRICE, { message: PRICE_MESSAGE })
  output!: string;

  @IsOptional()
  @Matches(PRICE, { message: PRICE_MESSAGE })
  cacheRead?: string;

  @IsOptional()
  @Matches(PRICE, { message: PRICE_MESSAGE })
  cacheWrite5m?: string;

  @IsOptional()
  @Matches(PRICE, { message: PRICE_MESSAGE })
  cacheWrite1h?: string;

  @IsOptional()
  @Matches(PRICE, { message: PRICE_MESSAGE })
  reasoning?: string;
}

export class PriceTierDto implements PriceTier {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name!: string;

  @IsBoolean()
  isDefault!: boolean;

  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => TierConditionDto)
  conditions!: TierConditionDto[];

  @ValidateNested()
  @Type(() => TierPricesDto)
  prices!: TierPricesDto;
}

export class ModelPriceDto implements ModelPriceInput {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  modelName!: string;

  /** Compiled by the service; an invalid regex is a 400 `invalid_price`. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  matchPattern!: string;

  @IsInt()
  @Min(-1000)
  @Max(1000)
  priority!: number;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => PriceTierDto)
  tiers!: PriceTierDto[];
}

/** `POST /admin/prices/versions`. */
export class CreatePriceVersionDto implements CreatePriceVersionRequest {
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  note!: string;

  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => ModelPriceDto)
  upsert!: ModelPriceDto[];

  @IsArray()
  @ArrayMaxSize(500)
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  @MaxLength(200, { each: true })
  remove!: string[];
}

export class TokensDto implements Partial<TokenBuckets> {
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_TOKENS)
  input?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_TOKENS)
  output?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_TOKENS)
  cacheRead?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_TOKENS)
  cacheWrite5m?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_TOKENS)
  cacheWrite1h?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_TOKENS)
  reasoning?: number;
}

/** `POST /admin/prices/test`. */
export class PriceTestDto implements PriceTestRequest {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  model!: string;

  @ValidateNested()
  @Type(() => TokensDto)
  tokens!: TokensDto;
}

/** `POST /admin/prices/recompute`. */
export class RecomputeDto implements RecomputeRequest {
  @IsISO8601({ strict: true })
  @Transform(toUtcIso)
  from!: string;

  @IsISO8601({ strict: true })
  @Transform(toUtcIso)
  to!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  versionId!: string;
}

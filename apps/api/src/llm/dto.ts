import {
  LLM_PROVIDERS,
  type LlmDefaultModel,
  type LlmKeyUpdate,
  type LlmProviderId,
  type LlmProviderUpdate,
} from '@nautelle/shared';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/** A model id as providers write them: `claude-opus-5-5`, `openai/gpt-5.1`, `grok-4:free`. */
export const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/;

export class ProviderParam {
  @IsIn(LLM_PROVIDERS)
  provider!: LlmProviderId;
}

export class LlmKeyUpdateDto implements LlmKeyUpdate {
  @Transform(trim)
  @IsString()
  @MinLength(12)
  @MaxLength(500)
  // Printable, no whitespace: a pasted key with a line break is a mistake.
  @Matches(/^\S+$/, { message: 'key must not contain whitespace' })
  key!: string;
}

export class LlmProviderUpdateDto implements LlmProviderUpdate {
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2, allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(1_000_000)
  capUsd?: number;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(200, { each: true })
  @Matches(MODEL_ID, { each: true, message: 'each model must be a model id' })
  models?: string[];
}

export class LlmDefaultModelDto implements LlmDefaultModel {
  @IsIn(LLM_PROVIDERS)
  provider!: LlmProviderId;

  @IsString()
  @MaxLength(200)
  @Matches(MODEL_ID, { message: 'model must be a model id' })
  model!: string;
}

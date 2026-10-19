import { AI_LANGUAGE_PATTERN, type AiSummaryRequest } from '@agentdock/shared';
import { IsBoolean, IsOptional, IsString, Matches } from 'class-validator';

/** `POST …/summary` (#658): the reader's language, and whether to make it again. */
export class AiSummaryDto implements AiSummaryRequest {
  @IsString()
  @Matches(AI_LANGUAGE_PATTERN, {
    message: 'language must be a BCP 47 primary language, e.g. en',
  })
  language!: string;

  @IsOptional()
  @IsBoolean()
  regenerate?: boolean;
}

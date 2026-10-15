import type {
  TextNormalizationsQuery,
  UpdateTextSettingsBody,
} from '@agentdock/shared';
import { IsBoolean, IsOptional, Matches } from 'class-validator';

const ID = /^[A-Za-z0-9_-]{1,64}$/;

/** `GET /text-normalizations`: exactly one of the two (else 400). */
export class TextNormalizationsQueryDto implements TextNormalizationsQuery {
  @IsOptional()
  @Matches(ID, { message: 'cardId is not a card id' })
  cardId?: string;

  @IsOptional()
  @Matches(ID, { message: 'planId is not a plan id' })
  planId?: string;
}

/** `PUT /text-settings` (D13). */
export class UpdateTextSettingsDto implements UpdateTextSettingsBody {
  @IsBoolean()
  normalizeEnabled!: boolean;
}

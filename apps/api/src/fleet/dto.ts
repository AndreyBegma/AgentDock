import {
  FLEET_SLOTS_PAGE_MAX,
  SLOT_STATUSES,
  type SlotStatus,
} from '@agentdock/shared';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/** `GET /projects/:projectId/slots`. */
export class SlotListQuery {
  @IsOptional()
  @IsIn(SLOT_STATUSES)
  status?: SlotStatus;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  issue?: number;

  /** `nextCursor` of the previous page. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(FLEET_SLOTS_PAGE_MAX)
  limit?: number;
}

/** `GET /projects/:projectId/rounds`. */
export class RoundListQuery {
  @IsOptional()
  @IsISO8601({ strict: true })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'date must be YYYY-MM-DD' })
  date?: string;
}

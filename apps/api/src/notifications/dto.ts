import {
  NOTIFICATION_KINDS,
  NOTIFICATION_PAGE_MAX,
  type NotificationKind,
  type NotificationMuteUpdate,
  type NotificationRulesUpdate,
} from '@agentdock/shared';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

/** `?unread=true|false` — anything else is refused, not read as false. */
const queryBoolean = ({ value }: { value: unknown }): unknown =>
  value === 'true' ? true : value === 'false' ? false : value;

/** `GET /notifications`. */
export class NotificationListQueryDto {
  @IsOptional()
  @Transform(queryBoolean)
  @IsBoolean()
  unread?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(NOTIFICATION_PAGE_MAX)
  limit?: number;
}

export class NotificationRuleDto {
  @IsIn(NOTIFICATION_KINDS)
  kind!: NotificationKind;

  @IsBoolean()
  inApp!: boolean;

  @IsBoolean()
  telegram!: boolean;
}

/** `PUT /notifications/rules`. */
export class NotificationRulesDto implements NotificationRulesUpdate {
  @IsArray()
  @ArrayMaxSize(NOTIFICATION_KINDS.length)
  @ValidateNested({ each: true })
  @Type(() => NotificationRuleDto)
  rules!: NotificationRuleDto[];
}

/** `PUT /notifications/mutes/:projectId` — `until` absent or null: until removed. */
export class NotificationMuteDto implements NotificationMuteUpdate {
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsDateString({ strict: true })
  until?: string | null;
}

import {
  SCHEDULE_CRON_MAX_LENGTH,
  SCHEDULE_MISSED_POLICIES,
  SCHEDULE_NAME_MAX_LENGTH,
  type ScheduleCreateRequest,
  type ScheduleMissedPolicy,
  type SchedulePreviewRequest,
  type ScheduleTarget,
  type ScheduleUpdateRequest,
} from '@agentdock/shared';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

const TIMEZONE_MAX_LENGTH = 64;

/**
 * `target` is a closed union (D1); its shape is checked by
 * `scheduleTargetSchema` so a bad one is 422 `invalid_target`, not 400.
 */
export class ScheduleCreateDto implements ScheduleCreateRequest {
  @IsString()
  @IsNotEmpty()
  @MaxLength(SCHEDULE_NAME_MAX_LENGTH)
  name!: string;

  @IsObject()
  target!: ScheduleTarget;

  @IsString()
  @MaxLength(SCHEDULE_CRON_MAX_LENGTH)
  cron!: string;

  @IsString()
  @MaxLength(TIMEZONE_MAX_LENGTH)
  timezone!: string;

  @IsOptional()
  @IsIn(SCHEDULE_MISSED_POLICIES)
  missedPolicy?: ScheduleMissedPolicy;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

/** `PATCH` — only the fields sent change. */
export class ScheduleUpdateDto implements ScheduleUpdateRequest {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(SCHEDULE_NAME_MAX_LENGTH)
  name?: string;

  @IsOptional()
  @IsObject()
  target?: ScheduleTarget;

  @IsOptional()
  @IsString()
  @MaxLength(SCHEDULE_CRON_MAX_LENGTH)
  cron?: string;

  @IsOptional()
  @IsString()
  @MaxLength(TIMEZONE_MAX_LENGTH)
  timezone?: string;

  @IsOptional()
  @IsIn(SCHEDULE_MISSED_POLICIES)
  missedPolicy?: ScheduleMissedPolicy;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

export class SchedulePreviewDto implements SchedulePreviewRequest {
  @IsString()
  @MaxLength(SCHEDULE_CRON_MAX_LENGTH)
  cron!: string;

  @IsString()
  @MaxLength(TIMEZONE_MAX_LENGTH)
  timezone!: string;
}

/** `GET /admin/schedules?projectId=&enabled=`. */
export class AdminSchedulesQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  projectId?: string;

  @IsOptional()
  @Transform(({ value }) =>
    value === 'true' ? true : value === 'false' ? false : value,
  )
  @IsBoolean()
  enabled?: boolean;
}

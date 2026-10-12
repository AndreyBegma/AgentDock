import {
  type AdminBudgetCreateRequest,
  BUDGET_ACTIONS,
  BUDGET_LIMIT_PATTERN,
  BUDGET_MAX_THRESHOLDS,
  BUDGET_OVERRIDE_REASON_MAX,
  BUDGET_PERIODS,
  BUDGET_SCOPES,
  BUDGET_STATES,
  type BudgetAction,
  type BudgetCreateRequest,
  type BudgetListQuery,
  type BudgetOverrideRequest,
  type BudgetPeriod,
  type BudgetRecomputeRequest,
  type BudgetScope,
  type BudgetState,
  type BudgetUpdateRequest,
} from '@agentdock/shared';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/** Shapes only; `BudgetsService` applies the D1 rules (zone, thresholds, > 0). */
const ID_MAX_LENGTH = 64;
const ZONE_MAX_LENGTH = 64;
const LIMIT_MESSAGE =
  'limitUsd must be a decimal with at most 10 integer and 4 fraction digits';

export class BudgetCreateDto implements BudgetCreateRequest {
  @IsIn(BUDGET_PERIODS)
  period!: BudgetPeriod;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(ZONE_MAX_LENGTH)
  timezone?: string;

  @IsString()
  @Matches(BUDGET_LIMIT_PATTERN, { message: LIMIT_MESSAGE })
  limitUsd!: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(BUDGET_MAX_THRESHOLDS)
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(100, { each: true })
  thresholds?: number[];

  @IsIn(BUDGET_ACTIONS)
  action!: BudgetAction;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

export class AdminBudgetCreateDto
  extends BudgetCreateDto
  implements AdminBudgetCreateRequest
{
  @IsIn(BUDGET_SCOPES)
  scope!: BudgetScope;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(ID_MAX_LENGTH)
  projectId?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(ID_MAX_LENGTH)
  userId?: string;
}

export class BudgetUpdateDto implements BudgetUpdateRequest {
  @IsOptional()
  @IsIn(BUDGET_PERIODS)
  period?: BudgetPeriod;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(ZONE_MAX_LENGTH)
  timezone?: string;

  @IsOptional()
  @IsString()
  @Matches(BUDGET_LIMIT_PATTERN, { message: LIMIT_MESSAGE })
  limitUsd?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(BUDGET_MAX_THRESHOLDS)
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(100, { each: true })
  thresholds?: number[];

  @IsOptional()
  @IsIn(BUDGET_ACTIONS)
  action?: BudgetAction;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

export class BudgetListQueryDto implements BudgetListQuery {
  @IsOptional()
  @IsIn(BUDGET_SCOPES)
  scope?: BudgetScope;

  @IsOptional()
  @IsIn(BUDGET_STATES)
  state?: BudgetState;
}

export class BudgetOverrideDto implements BudgetOverrideRequest {
  @IsISO8601({ strict: true })
  until!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(BUDGET_OVERRIDE_REASON_MAX)
  reason!: string;
}

export class BudgetRecomputeDto implements BudgetRecomputeRequest {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(ID_MAX_LENGTH)
  budgetId?: string;
}

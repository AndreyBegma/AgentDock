import type {
  UsageBreakdownResponse,
  UsageSummaryResponse,
  UsageTimeseriesResponse,
} from '@agentdock/shared';
import { Controller, Get, Query } from '@nestjs/common';
import type { AuthUser } from '../auth/auth-request';
import { CurrentUser } from '../auth/decorators';
import { UsageBreakdownDto, UsageRangeDto, UsageTimeseriesDto } from './dto';
import { UsageQueryService } from './usage-query.service';

/** Spec 13 usage API. Signed in; what each caller sees follows D9. */
@Controller('usage')
export class UsageController {
  constructor(private readonly usage: UsageQueryService) {}

  @Get('summary')
  summary(
    @CurrentUser() user: AuthUser,
    @Query() query: UsageRangeDto,
  ): Promise<UsageSummaryResponse> {
    return this.usage.summary(user, query);
  }

  @Get('timeseries')
  timeseries(
    @CurrentUser() user: AuthUser,
    @Query() query: UsageTimeseriesDto,
  ): Promise<UsageTimeseriesResponse> {
    return this.usage.timeseries(user, query);
  }

  @Get('breakdown')
  breakdown(
    @CurrentUser() user: AuthUser,
    @Query() query: UsageBreakdownDto,
  ): Promise<UsageBreakdownResponse> {
    return this.usage.breakdown(user, query);
  }
}

import { Module } from '@nestjs/common';
import { UsageModule } from '../usage/usage.module';
import { CostService } from './cost.service';
import { PricesController } from './prices.controller';
import { PricesService } from './prices.service';
import { RecomputeService } from './recompute.service';

/** The versioned price table, request cost and recompute (docs/specs/13). */
@Module({
  imports: [UsageModule],
  controllers: [PricesController],
  providers: [CostService, PricesService, RecomputeService],
  exports: [CostService],
})
export class PricesModule {}

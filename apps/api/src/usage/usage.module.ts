import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects';
import { RollupService } from './rollup.service';
import { UsageController } from './usage.controller';
import { UsageQueryService } from './usage-query.service';

/** Usage rollups and the `/usage` API (docs/specs/13). */
@Module({
  imports: [ProjectsModule],
  controllers: [UsageController],
  providers: [RollupService, UsageQueryService],
  exports: [RollupService],
})
export class UsageModule {}

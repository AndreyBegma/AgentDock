import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects';
import { RunnersModule } from '../runners/runners.module';
import { ReadinessController } from './readiness.controller';
import { ReadinessService } from './readiness.service';
import { RuntimeProfileResolver } from './runtime-profile.resolver';

/**
 * Project readiness (issue #272): the one runtime-profile rule
 * (`RuntimeProfileResolver`, exported for every model-running module) and
 * the per-action preflight the web checks before acting.
 */
@Module({
  imports: [ProjectsModule, RunnersModule],
  controllers: [ReadinessController],
  providers: [ReadinessService, RuntimeProfileResolver],
  exports: [RuntimeProfileResolver],
})
export class ReadinessModule {}

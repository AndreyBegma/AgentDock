import { Module } from '@nestjs/common';
import { FleetModule } from '../fleet';
import { LiveModule } from '../live/live.module';
import { ProjectsModule } from '../projects';
import { RunnersModule } from '../runners/runners.module';
import { ApprovalCommands } from './approval-commands';
import { ApprovalViews } from './approval-views';
import { ApprovalsController } from './approvals.controller';
import { ApprovalsService } from './approvals.service';
import { ApprovalsProjector } from './approvals-projector.service';
import { ApprovalsQueryService } from './approvals-query.service';
import { ApprovalsSink } from './approvals-sink';

/**
 * The merge approval queue (docs/specs/20): approval rows, their ingest and
 * routes. Imports `FleetModule` so the fleet sink registers, and projects each
 * batch, before the approvals sink reads slots. Exports `ApprovalsService` for
 * #22's approve buttons.
 */
@Module({
  imports: [ProjectsModule, LiveModule, RunnersModule, FleetModule],
  controllers: [ApprovalsController],
  providers: [
    ApprovalCommands,
    ApprovalViews,
    ApprovalsProjector,
    ApprovalsQueryService,
    ApprovalsService,
    ApprovalsSink,
  ],
  exports: [ApprovalsService],
})
export class ApprovalsModule {}

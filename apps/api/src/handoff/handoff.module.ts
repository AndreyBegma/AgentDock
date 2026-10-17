import { Module } from '@nestjs/common';
import { BoardModule } from '../board/board.module';
import { ProjectsModule } from '../projects';
import { RunnersModule } from '../runners/runners.module';
import { HandoffController } from './handoff.controller';
import { HandoffService } from './handoff.service';
import { HandoffSink } from './handoff-sink';

/**
 * Context handoff (#449, ADR-0042) on the API: the copy of each card's and
 * run's handoff note for a project that ships session content, a person's
 * edit sent to the runner as `card.handoff.set`, and each card round's
 * restart decision and warm-up from the runner's events.
 */
@Module({
  imports: [BoardModule, ProjectsModule, RunnersModule],
  controllers: [HandoffController],
  providers: [HandoffService, HandoffSink],
})
export class HandoffModule {}

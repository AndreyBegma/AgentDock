import { Module } from '@nestjs/common';
import { LiveModule } from '../live/live.module';
import { ProjectsModule } from '../projects';
import { ReadinessModule } from '../readiness';
import { RunnersModule } from '../runners/runners.module';
import { TextModule } from '../text';
import { BoardController } from './board.controller';
import { BoardService } from './board.service';
import { BoardCommands } from './board-commands';
import { BoardInboxService } from './board-inbox.service';
import { BoardRoundsService } from './board-rounds.service';
import { BoardSink } from './board-sink';
import { BoardWork } from './board-work';

/**
 * The project Board (issue #242, ADR-0024): cards AgentDock owns, each worked
 * by a dedicated interactive Claude Code worker outside the orchestrator.
 * `BoardService` is exported for the local `card.finish` method (D6).
 */
@Module({
  imports: [
    LiveModule,
    ProjectsModule,
    ReadinessModule,
    RunnersModule,
    TextModule,
  ],
  controllers: [BoardController],
  providers: [
    BoardCommands,
    BoardInboxService,
    BoardRoundsService,
    BoardService,
    BoardSink,
    BoardWork,
  ],
  // `BoardRoundsService` too: approving a card's design may start round 1 (#243 D6).
  // `BoardWork`: card capture puts suggestions in the Inbox (#244).
  exports: [BoardRoundsService, BoardService, BoardWork],
})
export class BoardModule {}

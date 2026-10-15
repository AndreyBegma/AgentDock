import { Module } from '@nestjs/common';
import { LiveModule } from '../live/live.module';
import { ProjectsModule } from '../projects';
import { ReadinessModule } from '../readiness';
import { RunnersModule } from '../runners/runners.module';
import { BoardController } from './board.controller';
import { BoardService, FleetCardEditsRef } from './board.service';
import { BoardCommands } from './board-commands';
import { BoardInboxService } from './board-inbox.service';
import { BoardRoundsService } from './board-rounds.service';
import { BoardSink } from './board-sink';
import { BoardTerminalService } from './board-terminal.service';
import { BoardWork } from './board-work';

/**
 * The project Board (issue #242, ADR-0024): cards AgentDock owns, each worked
 * by a dedicated interactive Claude Code worker outside the orchestrator.
 * `BoardService` is exported for the local `card.finish` method (D6) and for
 * the fleet's `FleetCardEdits` port (#282 D4, set on `FleetCardEditsRef`);
 * `BoardTerminalService` for `card.track` (#282 D1).
 */
@Module({
  imports: [LiveModule, ProjectsModule, ReadinessModule, RunnersModule],
  controllers: [BoardController],
  providers: [
    BoardCommands,
    BoardInboxService,
    BoardRoundsService,
    BoardService,
    BoardSink,
    BoardTerminalService,
    BoardWork,
    FleetCardEditsRef,
  ],
  // `BoardRoundsService` too: approving a card's design may start round 1 (#243 D6).
  // `BoardWork`: card capture puts suggestions in the Inbox (#244).
  exports: [
    BoardRoundsService,
    BoardService,
    BoardTerminalService,
    BoardWork,
    FleetCardEditsRef,
  ],
})
export class BoardModule {}

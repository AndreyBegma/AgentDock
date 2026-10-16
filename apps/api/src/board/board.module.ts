import { Module } from '@nestjs/common';
import { BoardAttachmentsController } from '../attachments/board-attachments.controller';
import { LiveModule } from '../live/live.module';
import { ProjectsModule } from '../projects';
import { ReadinessModule } from '../readiness';
import { RunnersModule } from '../runners/runners.module';
import { BoardController } from './board.controller';
import { BoardService, FleetCardEditsRef } from './board.service';
import { BoardCommands } from './board-commands';
import { BoardDependencies } from './board-dependencies.service';
import { BoardInboxService } from './board-inbox.service';
import { BoardPlanCards } from './board-plan-cards';
import { BoardRoundsService } from './board-rounds.service';
import { BoardShipping } from './board-shipping';
import { BoardSink } from './board-sink';
import { BoardTerminalService } from './board-terminal.service';
import { BoardWork } from './board-work';
import { CollectRetryTimer } from './collect-retry-timer';

/**
 * The project Board (issue #242, ADR-0024): cards AgentDock owns, each worked
 * by a dedicated interactive Claude Code worker outside the orchestrator.
 * `BoardService` is exported for the local `card.finish` method (D6) and for
 * the fleet's `FleetCardEdits` port (#282 D4, set on `FleetCardEditsRef`);
 * `BoardTerminalService` for `card.track` (#282 D1).
 */
@Module({
  // #309: `AttachmentsService` comes from the global `AttachmentsModule`.
  imports: [LiveModule, ProjectsModule, ReadinessModule, RunnersModule],
  // #309: claiming attachments onto a card is a card route.
  controllers: [BoardController, BoardAttachmentsController],
  providers: [
    BoardCommands,
    BoardDependencies,
    BoardInboxService,
    BoardPlanCards,
    BoardRoundsService,
    BoardService,
    // #359: a card ships itself — CI watched, fixed, merged.
    BoardShipping,
    BoardSink,
    BoardTerminalService,
    BoardWork,
    CollectRetryTimer,
    FleetCardEditsRef,
  ],
  // `BoardRoundsService` too: approving a card's design may start round 1 (#243 D6).
  // `BoardWork`: card capture puts suggestions in the Inbox (#244).
  // `BoardPlanCards`: a card intake and Create cards make cards (#337 D6, D7).
  exports: [
    BoardPlanCards,
    BoardRoundsService,
    BoardService,
    BoardTerminalService,
    BoardWork,
    FleetCardEditsRef,
  ],
})
export class BoardModule {}

import { Module } from '@nestjs/common';
import { BoardModule } from '../board/board.module';
import { LiveModule } from '../live/live.module';
import { ProjectsModule } from '../projects';
import { ReadinessModule } from '../readiness';
import { RunnersModule } from '../runners/runners.module';
import { SettingsModule } from '../settings/settings.module';
import { CardDesignTurnService } from './card-design-turn.service';
import { PlanService } from './plan.service';
import { PlanDocsSink } from './plan-docs-sink';
import { PlanSendService } from './plan-send.service';
import { PlanStore } from './plan-store';
import { PlanTurnService } from './plan-turn.service';
import { PlanTurnProjector } from './plan-turn-projector';
import {
  PlannerAdminController,
  TasksController,
} from './planner-admin.controller';
import { PlannerCommands } from './planner-commands';
import { PlannerInstructionsService } from './planner-instructions.service';
import { PlansController } from './plans.controller';
import { TasksQueryService } from './tasks-query.service';

/**
 * The Planner (docs/specs/172-planner.md): plans, turns, review, revise,
 * send to fleet, `/tasks`, and the instructions and settings editors. Turn
 * results arrive as `plan_turn.*` events (`PlanTurnProjector`); a docs pull
 * request's merge queues the features (`PlanDocsSink`).
 */
@Module({
  // #337: an intake and Create cards make board cards (`BoardModule`); a
  // plan's model defaults to its author's planning model (`SettingsModule`).
  imports: [
    BoardModule,
    LiveModule,
    ProjectsModule,
    ReadinessModule,
    RunnersModule,
    SettingsModule,
  ],
  controllers: [PlansController, PlannerAdminController, TasksController],
  providers: [
    CardDesignTurnService,
    PlanDocsSink,
    PlanSendService,
    PlanService,
    PlanStore,
    PlanTurnProjector,
    PlanTurnService,
    PlannerCommands,
    PlannerInstructionsService,
    TasksQueryService,
  ],
  // The design stage (spec 223) runs its turns through the planner's — a
  // board card's as well (#243).
  exports: [CardDesignTurnService, PlanStore, PlanTurnService, PlannerCommands],
})
export class PlannerModule {}

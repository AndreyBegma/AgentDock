import { Module } from '@nestjs/common';
import { PairingService } from './pairing.service';
import { RunnerGateway } from './runner.gateway';
import { RunnerCommandService } from './runner-command.service';
import { RunnerConnections } from './runner-connections';
import { RunnerEventSinks } from './runner-event-sinks';
import { RunnerIngestService } from './runner-ingest.service';
import { defaultRunnerOptions, RUNNER_OPTIONS } from './runner-options';
import { RunnerPresence } from './runner-presence';
import { RunnerWatchList } from './runner-watch-list';
import {
  AdminRunnersController,
  RunnerPairingController,
} from './runners.controller';
import { RunnersService } from './runners.service';

@Module({
  controllers: [AdminRunnersController, RunnerPairingController],
  providers: [
    { provide: RUNNER_OPTIONS, useValue: defaultRunnerOptions },
    RunnerConnections,
    RunnerEventSinks,
    RunnerIngestService,
    RunnerCommandService,
    RunnersService,
    PairingService,
    RunnerGateway,
    RunnerWatchList,
    RunnerPresence,
  ],
  // Later items send commands to runners through this (spec D8); projects
  // (#10) push the watch list and read runner status; sessions (#12) and fleet
  // (#11) register event sinks.
  exports: [
    RunnerCommandService,
    RunnerWatchList,
    RunnerPresence,
    RunnerEventSinks,
  ],
})
export class RunnersModule {}

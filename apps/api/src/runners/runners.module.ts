import { Module } from '@nestjs/common';
import { PairingService } from './pairing.service';
import { RunnerGateway } from './runner.gateway';
import { RunnerCommandService } from './runner-command.service';
import { RunnerConnections } from './runner-connections';
import { RunnerEventSinks } from './runner-event-sinks';
import { RunnerIngestService } from './runner-ingest.service';
import { RunnerLocalRequests } from './runner-local-requests';
import { defaultRunnerOptions, RUNNER_OPTIONS } from './runner-options';
import { RunnerPresence } from './runner-presence';
import { RunnerSettingsService } from './runner-settings.service';
import { RunnerStreams } from './runner-streams';
import { RunnerWatchList } from './runner-watch-list';
import {
  AdminRunnersController,
  RunnerPairingController,
  RunnerSettingsController,
} from './runners.controller';
import { RunnersService } from './runners.service';

@Module({
  controllers: [
    AdminRunnersController,
    RunnerSettingsController,
    RunnerPairingController,
  ],
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
    RunnerStreams,
    RunnerLocalRequests,
    RunnerSettingsService,
  ],
  // Later items send commands to runners through this (spec D8); projects
  // (#10) push the watch list and read runner status; sessions (#12) and fleet
  // (#11) register event sinks; the pane relay (#18) registers a stream listener.
  exports: [
    RunnerCommandService,
    RunnerWatchList,
    RunnerPresence,
    RunnerEventSinks,
    RunnerStreams,
    // Spec 201: the local module registers its router and sets away mode.
    RunnerLocalRequests,
    RunnerSettingsService,
  ],
})
export class RunnersModule {}

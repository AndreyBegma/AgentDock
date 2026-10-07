import { Module } from '@nestjs/common';
import { PairingService } from './pairing.service';
import { RunnerCommandService } from './runner-command.service';
import { RunnerConnections } from './runner-connections';
import { RunnerIngestService } from './runner-ingest.service';
import { defaultRunnerOptions, RUNNER_OPTIONS } from './runner-options';
import { RunnerGateway } from './runner.gateway';
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
    RunnerIngestService,
    RunnerCommandService,
    RunnersService,
    PairingService,
    RunnerGateway,
  ],
  // Later items send commands to runners through this (spec D8).
  exports: [RunnerCommandService],
})
export class RunnersModule {}

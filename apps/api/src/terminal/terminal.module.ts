import { Module, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthModule } from '../auth';
import { ProjectsModule } from '../projects';
import { RunnerStreams } from '../runners/runner-streams';
import { RunnersModule } from '../runners/runners.module';
import { TerminalController } from './terminal.controller';
import { TerminalGateway } from './terminal.gateway';
import { TerminalService } from './terminal.service';
import { TERMINAL_OPTIONS, terminalOptions } from './terminal-options';
import { TerminalRelay } from './terminal-relay';
import {
  RunnerTerminalPort,
  TERMINAL_RUNNER_PORT,
} from './terminal-runner-port';
import { TerminalTickets } from './terminal-tickets';

/**
 * Interactive terminal attach (docs/specs/29-terminal-attach.md): one-time
 * tickets, the `/terminal` socket and the relay to the runner. Nothing is
 * stored but the audit of who attached, how, for how long, and how many bytes.
 */
@Module({
  imports: [AuthModule, ProjectsModule, RunnersModule],
  controllers: [TerminalController],
  providers: [
    {
      provide: TERMINAL_OPTIONS,
      inject: [ConfigService],
      useFactory: terminalOptions,
    },
    { provide: TERMINAL_RUNNER_PORT, useClass: RunnerTerminalPort },
    TerminalTickets,
    TerminalRelay,
    TerminalService,
    TerminalGateway,
  ],
  exports: [TerminalRelay],
})
export class TerminalModule implements OnModuleInit {
  constructor(
    private readonly streams: RunnerStreams,
    private readonly relay: TerminalRelay,
  ) {}

  onModuleInit(): void {
    // A runner's socket coming or going ends its attaches.
    this.streams.register(this.relay);
  }
}

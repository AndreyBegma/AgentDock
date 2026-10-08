import type { RunnerEvent } from '@agentdock/shared/protocol';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  type RunnerEventSink,
  RunnerEventSinks,
} from '../runners/runner-event-sinks';
import { ApprovalsProjector } from './approvals-projector.service';

/**
 * Feeds every incoming runner batch to the approvals projector. Registered
 * after the fleet sink — `ApprovalsModule` imports `FleetModule`, whose
 * `onModuleInit` therefore runs first — so a batch's slots and PRs are
 * projected before the approvals read them.
 */
@Injectable()
export class ApprovalsSink implements RunnerEventSink, OnModuleInit {
  readonly name = 'approvals';

  constructor(
    private readonly sinks: RunnerEventSinks,
    private readonly projector: ApprovalsProjector,
  ) {}

  onModuleInit(): void {
    this.sinks.register(this);
  }

  handle(runnerId: string, events: RunnerEvent[]): Promise<void> {
    return this.projector.handle(runnerId, events);
  }
}

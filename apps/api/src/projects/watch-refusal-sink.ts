import {
  type RunnerEvent,
  WATCH_REFUSED_EVENT,
  type WatchRefusal,
  watchRefusedDataSchema,
} from '@agentdock/shared/protocol';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import {
  type RunnerEventSink,
  RunnerEventSinks,
} from '../runners/runner-event-sinks';

/**
 * #691: keeps `Project.watchRefusal` in step with the runner. A
 * `runner.watch_refused` names every project of the runner its local policy
 * refuses (ADR-0047), so the latest one in a batch is the whole truth: its
 * projects get its message, the runner's other projects are cleared. Only the
 * runner reports this; nothing here can change its policy.
 */
@Injectable()
export class WatchRefusalSink implements RunnerEventSink, OnModuleInit {
  readonly name = 'watch-refusal';
  private readonly logger = new Logger(WatchRefusalSink.name);

  constructor(
    private readonly sinks: RunnerEventSinks,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit(): void {
    this.sinks.register(this);
  }

  async handle(runnerId: string, events: RunnerEvent[]): Promise<void> {
    let latest: WatchRefusal[] | null = null;
    for (const event of events) {
      if (event.type !== WATCH_REFUSED_EVENT) continue;
      const parsed = watchRefusedDataSchema.safeParse(event.data);
      if (!parsed.success) {
        this.logger.warn(
          `runner ${runnerId}: malformed ${event.type} (seq ${event.seq}), skipped`,
        );
        continue;
      }
      latest = parsed.data.projects;
    }
    if (latest) await this.apply(runnerId, latest);
  }

  private async apply(
    runnerId: string,
    refused: WatchRefusal[],
  ): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.project.updateMany({
        where: {
          runnerId,
          id: { notIn: refused.map((r) => r.projectId) },
          watchRefusal: { not: null },
        },
        data: { watchRefusal: null },
      }),
      // A project of another runner keeps what its own runner said.
      ...refused.map((r) =>
        this.prisma.project.updateMany({
          where: { runnerId, id: r.projectId },
          data: { watchRefusal: r.message },
        }),
      ),
    ]);
  }
}

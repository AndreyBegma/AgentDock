import { Module, type OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { LiveModule } from '../live/live.module';
import { LiveTopicHookRegistry } from '../live/live-topic-hooks';
import { TopicAuthorizerRegistry } from '../live/topic-authorizer.registry';
import { ProjectAccessService, ProjectsModule } from '../projects';
import { RunnerStreams } from '../runners/runner-streams';
import { RunnersModule } from '../runners/runners.module';
import { authorizePane } from './pane-authorizer';
import { PaneRelay } from './pane-relay';

/**
 * Live read-only worker pane (docs/specs/18): the `pane:<projectId>:<slot>`
 * topic, its authorizer, and the relay between runner streams and `/live`.
 * No REST routes; nothing is stored but the audit of who watched.
 */
@Module({
  imports: [LiveModule, ProjectsModule, RunnersModule],
  providers: [PaneRelay],
  exports: [PaneRelay],
})
export class PaneModule implements OnModuleInit {
  constructor(
    private readonly topics: TopicAuthorizerRegistry,
    private readonly hooks: LiveTopicHookRegistry,
    private readonly streams: RunnerStreams,
    private readonly access: ProjectAccessService,
    private readonly prisma: PrismaService,
    private readonly relay: PaneRelay,
  ) {}

  onModuleInit(): void {
    this.topics.register('pane', (user, id) =>
      authorizePane(this.access, this.prisma, user, id),
    );
    this.hooks.register('pane', this.relay);
    this.streams.register(this.relay);
  }
}

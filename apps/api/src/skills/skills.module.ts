import { Module, type OnModuleInit } from '@nestjs/common';
import { ActivityModule } from '../activity';
import { CommandRunsService } from '../control/command-runs.service';
import { PrismaService } from '../database/prisma.service';
import { RunsQueryService } from '../history/runs-query.service';
import { LiveModule } from '../live/live.module';
import { LiveTopicHookRegistry } from '../live/live-topic-hooks';
import { TopicAuthorizerRegistry } from '../live/topic-authorizer.registry';
import { ProjectAccessService, ProjectsModule } from '../projects';
import { RunnerStreams } from '../runners/runner-streams';
import { RunnersModule } from '../runners/runners.module';
import { RunLogRelay } from './run-log-relay';
import { authorizeRun } from './run-topic';
import { SkillCommands } from './skill-commands';
import { SkillInstallService } from './skill-install.service';
import { SkillInventoryService } from './skill-inventory.service';
import { SkillRunService } from './skill-run.service';
import { SkillRunProjector } from './skill-run-projector';
import {
  ProfileSkillsController,
  ProjectSkillsController,
  SkillsController,
} from './skills.controller';

/**
 * Skills (docs/specs/24): the skills.sh catalog through the runner, inspect
 * and install, the inventory, skill runs and their live log.
 * `SkillRunService` is exported for schedules (#25) and webhooks (#26).
 *
 * `CommandRunsService` (#17) and `RunsQueryService` (#21) are stateless and
 * not exported by their modules, so this module provides its own instances.
 */
@Module({
  imports: [ActivityModule, LiveModule, ProjectsModule, RunnersModule],
  controllers: [
    SkillsController,
    ProfileSkillsController,
    ProjectSkillsController,
  ],
  providers: [
    CommandRunsService,
    RunsQueryService,
    RunLogRelay,
    SkillCommands,
    SkillInstallService,
    SkillInventoryService,
    SkillRunProjector,
    SkillRunService,
  ],
  exports: [SkillRunService],
})
export class SkillsModule implements OnModuleInit {
  constructor(
    private readonly topics: TopicAuthorizerRegistry,
    private readonly hooks: LiveTopicHookRegistry,
    private readonly streams: RunnerStreams,
    private readonly access: ProjectAccessService,
    private readonly prisma: PrismaService,
    private readonly relay: RunLogRelay,
  ) {}

  onModuleInit(): void {
    this.topics.register('run', (user, id) =>
      authorizeRun(this.access, this.prisma, user, id),
    );
    this.hooks.register('run', this.relay);
    this.streams.register(this.relay);
  }
}

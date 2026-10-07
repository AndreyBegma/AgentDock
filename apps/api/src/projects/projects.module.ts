import { Module, type OnModuleInit } from '@nestjs/common';
import { LiveModule } from '../live/live.module';
import { TopicAuthorizerRegistry } from '../live/topic-authorizer.registry';
import { RunnersModule } from '../runners/runners.module';
import { ProjectAccessGuard } from './project-access.guard';
import { ProjectAccessService } from './project-access.service';
import { ProjectInspector } from './project-inspector';
import { ProjectMembersService } from './project-members.service';
import {
  AdminProjectsController,
  ProjectsController,
} from './projects.controller';
import { ProjectsService } from './projects.service';

@Module({
  imports: [RunnersModule, LiveModule],
  controllers: [AdminProjectsController, ProjectsController],
  providers: [
    ProjectAccessService,
    ProjectAccessGuard,
    ProjectInspector,
    ProjectsService,
    ProjectMembersService,
  ],
  // #11–#13 import this module and put `@UseGuards(ProjectAccessGuard)` and
  // `@ProjectRole()` on their `:projectId` routes (spec 10 D12).
  exports: [ProjectAccessService, ProjectAccessGuard],
})
export class ProjectsModule implements OnModuleInit {
  constructor(
    private readonly topics: TopicAuthorizerRegistry,
    private readonly access: ProjectAccessService,
  ) {}

  /** D17: `project:<id>` follows the same rule as the project's REST routes. */
  onModuleInit(): void {
    this.topics.register(
      'project',
      async (user, id) =>
        id !== null && (await this.access.resolve(user, id)) !== null,
    );
  }
}

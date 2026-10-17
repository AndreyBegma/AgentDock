import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects';
import { ProjectRuleScanService } from './project-rule-scan.service';
import {
  AdminProjectRulesController,
  ProjectRulesController,
} from './project-rules.controller';
import { ProjectRulesService } from './project-rules.service';

/** Per-project coding rules (#528): the model, the API, the import and the scan (#584). */
@Module({
  imports: [ProjectsModule],
  controllers: [ProjectRulesController, AdminProjectRulesController],
  providers: [ProjectRulesService, ProjectRuleScanService],
  exports: [ProjectRulesService],
})
export class ProjectRulesModule {}

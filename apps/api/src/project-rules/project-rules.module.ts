import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects';
import { ProjectRulesController } from './project-rules.controller';
import { ProjectRulesService } from './project-rules.service';

/** Per-project coding rules (#528): the model, the API and the import. */
@Module({
  imports: [ProjectsModule],
  controllers: [ProjectRulesController],
  providers: [ProjectRulesService],
  exports: [ProjectRulesService],
})
export class ProjectRulesModule {}

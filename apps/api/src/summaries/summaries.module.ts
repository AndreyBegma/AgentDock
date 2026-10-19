import { Module } from '@nestjs/common';
import { LlmModule } from '../llm/llm.module';
import { ProjectsModule } from '../projects';
import { SummariesController } from './summaries.controller';
import { SummariesService } from './summaries.service';

/** One-click card and session summaries on the LLM gateway (#658, ADR-0059). */
@Module({
  imports: [LlmModule, ProjectsModule],
  controllers: [SummariesController],
  providers: [SummariesService],
})
export class SummariesModule {}

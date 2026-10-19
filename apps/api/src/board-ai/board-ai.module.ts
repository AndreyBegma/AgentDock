import { Module } from '@nestjs/common';
import { BoardModule } from '../board/board.module';
import { LlmModule } from '../llm/llm.module';
import { ProjectsModule } from '../projects';
import {
  BoardAskController,
  BoardTriageController,
} from './board-ai.controller';
import { BoardAiModel } from './board-ai-model';
import { BoardAskService } from './board-ask.service';
import { BoardTriage } from './board-triage.service';

/**
 * #660: Ask the Board and triage hints, on the LLM gateway (ADR-0059) with
 * the feature tags `search` and `triage`. The intake and the assistant import
 * it to triage the cards they make.
 */
@Module({
  imports: [LlmModule, BoardModule, ProjectsModule],
  controllers: [BoardAskController, BoardTriageController],
  providers: [BoardAiModel, BoardAskService, BoardTriage],
  exports: [BoardTriage],
})
export class BoardAiModule {}

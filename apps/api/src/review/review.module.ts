import { Module } from '@nestjs/common';
import { LlmModule } from '../llm/llm.module';
import { ProjectsModule } from '../projects';
import { RunnersModule } from '../runners/runners.module';
import { SkillsModule } from '../skills';
import { PeerReviewGenerator } from './peer-review-generator';
import { ReviewController } from './review.controller';
import { ReviewService } from './review.service';

/**
 * Per-project review steps (#862, ADR-0084): the switches, the steps, and
 * the generated peer review instructions. Running the steps is the engine's.
 */
@Module({
  imports: [LlmModule, ProjectsModule, RunnersModule, SkillsModule],
  controllers: [ReviewController],
  providers: [ReviewService, PeerReviewGenerator],
  exports: [ReviewService],
})
export class ReviewModule {}

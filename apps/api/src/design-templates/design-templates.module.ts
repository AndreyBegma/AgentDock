import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects';
import { DesignTemplatesController } from './design-templates.controller';
import { DesignTemplatesService } from './design-templates.service';

/** A project's design frame templates (#833, ADR-0082): list, save, reset. */
@Module({
  imports: [ProjectsModule],
  controllers: [DesignTemplatesController],
  providers: [DesignTemplatesService],
})
export class DesignTemplatesModule {}

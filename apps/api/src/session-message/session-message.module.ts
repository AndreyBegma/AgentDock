import { Module } from '@nestjs/common';
import { RunnersModule } from '../runners/runners.module';
import { SessionMessageService } from './session-message.service';

/** #489: a person's messages to running sessions. */
@Module({
  imports: [RunnersModule],
  providers: [SessionMessageService],
  exports: [SessionMessageService],
})
export class SessionMessageModule {}

import { Module } from '@nestjs/common';
import { AuthModule } from '../auth';
import { LiveGateway } from './live.gateway';
import { LiveService } from './live.service';
import { LiveConnections } from './live-connections';
import { LiveMonitor } from './live-monitor';
import { defaultLiveOptions, LIVE_OPTIONS } from './live-options';
import { TopicAuthorizerRegistry } from './topic-authorizer.registry';

@Module({
  imports: [AuthModule],
  providers: [
    { provide: LIVE_OPTIONS, useValue: defaultLiveOptions },
    LiveConnections,
    TopicAuthorizerRegistry,
    LiveService,
    LiveMonitor,
    LiveGateway,
  ],
  // Domain modules publish through LiveService and register their topic
  // prefix (`project:` in #10) with the registry.
  exports: [LiveService, TopicAuthorizerRegistry],
})
export class LiveModule {}

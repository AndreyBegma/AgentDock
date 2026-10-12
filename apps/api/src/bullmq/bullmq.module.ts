import { BullModule } from '@nestjs/bullmq';
import { Global, Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { QUEUE_ENABLED, queueOptions, redisConnection } from './bullmq-options';

const logger = new Logger('BullmqModule');

/**
 * The BullMQ connection (spec 123, ADR-0015): one Redis connection config and
 * prefix for every queue. Global, so a feature module only calls
 * `BullModule.registerQueue`. Nothing connects until a queue is registered.
 */
@Global()
@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const options = queueOptions(config);
        if (!options.redisUrl) {
          logger.log('REDIS_URL is unset and the scheduler is off: no queues');
        }
        return {
          prefix: options.prefix,
          // Unused when disabled: no queue is registered without a URL.
          connection: redisConnection(
            options.redisUrl ?? 'redis://localhost:6379',
          ),
        };
      },
    }),
  ],
  providers: [
    {
      provide: QUEUE_ENABLED,
      inject: [ConfigService],
      useFactory: (config: ConfigService): boolean =>
        queueOptions(config).enabled,
    },
  ],
  exports: [QUEUE_ENABLED, BullModule],
})
export class BullmqModule {}

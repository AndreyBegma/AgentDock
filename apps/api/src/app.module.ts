import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AdminModule } from './admin/admin.module';
import { AuthModule } from './auth/auth.module';
import { DatabaseModule } from './database/database.module';
import { HealthController } from './health.controller';
import { LiveModule } from './live/live.module';
import { RunnersModule } from './runners/runners.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    DatabaseModule,
    AuthModule,
    AdminModule,
    RunnersModule,
    LiveModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}

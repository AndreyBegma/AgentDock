import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AdminModule } from './admin/admin.module';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { DatabaseModule } from './database/database.module';
import { FleetModule } from './fleet';
import { HealthController } from './health.controller';
import { LiveModule } from './live/live.module';
import { PricesModule } from './prices/prices.module';
import { ProjectsModule } from './projects/projects.module';
import { QueueModule } from './queue';
import { RunnersModule } from './runners/runners.module';
import { SessionsModule } from './sessions/sessions.module';
import { UsageModule } from './usage/usage.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    DatabaseModule,
    AuditModule,
    AuthModule,
    AdminModule,
    RunnersModule,
    LiveModule,
    ProjectsModule,
    FleetModule,
    SessionsModule,
    UsageModule,
    PricesModule,
    QueueModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}

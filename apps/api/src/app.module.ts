import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AdminModule } from './admin/admin.module';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { ControlModule } from './control';
import { DatabaseModule } from './database/database.module';
import { FleetModule } from './fleet';
import { HealthController } from './health.controller';
import { LiveModule } from './live/live.module';
import { ProjectsModule } from './projects/projects.module';
import { QueueModule } from './queue';
import { RunnersModule } from './runners/runners.module';
import { SessionsModule } from './sessions/sessions.module';

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
    QueueModule,
    ControlModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}

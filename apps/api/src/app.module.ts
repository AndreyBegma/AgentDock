import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AdminModule } from './admin/admin.module';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { DatabaseModule } from './database/database.module';
import { HealthController } from './health.controller';
import { LiveModule } from './live/live.module';
import { ProjectsModule } from './projects/projects.module';
import { RunnersModule } from './runners/runners.module';

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
  ],
  controllers: [HealthController],
})
export class AppModule {}

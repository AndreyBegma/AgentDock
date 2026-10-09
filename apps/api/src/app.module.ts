import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ActivityModule } from './activity';
import { AdminModule } from './admin/admin.module';
import { ApprovalsModule } from './approvals';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { BudgetsModule } from './budgets';
import { ControlModule } from './control';
import { DatabaseModule } from './database/database.module';
import { FleetModule } from './fleet';
import { HealthController } from './health.controller';
import { HistoryModule } from './history';
import { LiveModule } from './live/live.module';
import { NotificationsModule } from './notifications';
import { PaneModule } from './pane';
import { PricesModule } from './prices/prices.module';
import { ProjectsModule } from './projects/projects.module';
import { QueueModule } from './queue';
import { RunnersModule } from './runners/runners.module';
import { SchedulesModule } from './schedules';
import { SessionsModule } from './sessions/sessions.module';
import { SkillsModule } from './skills';
import { TelegramModule } from './telegram';
import { TerminalModule } from './terminal';
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
    PaneModule,
    ControlModule,
    ActivityModule,
    HistoryModule,
    ApprovalsModule,
    NotificationsModule,
    TelegramModule,
    TerminalModule,
    SkillsModule,
    SchedulesModule,
    BudgetsModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}

import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ActivityModule } from './activity';
import { AdminModule } from './admin/admin.module';
import { ApprovalsModule } from './approvals';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { BoardModule } from './board';
import { BudgetsModule } from './budgets';
import { BullmqModule } from './bullmq';
import { CaptureModule } from './capture';
import { ControlModule } from './control';
import { DatabaseModule } from './database/database.module';
import { DesignModule } from './design/design.module';
import { FleetModule } from './fleet';
import { GitHubAppModule } from './github-app';
import { HealthController } from './health.controller';
import { HistoryModule } from './history';
import { LiveModule } from './live/live.module';
import { LocalModule } from './local';
import { NotificationsModule } from './notifications';
import { PaneModule } from './pane';
import { PlannerModule } from './planner';
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
import { WebhooksModule } from './webhooks';
import { WorkflowsModule } from './workflows';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    DatabaseModule,
    BullmqModule,
    AuditModule,
    AuthModule,
    AdminModule,
    RunnersModule,
    LiveModule,
    ProjectsModule,
    FleetModule,
    SessionsModule,
    WorkflowsModule,
    UsageModule,
    PricesModule,
    QueueModule,
    PaneModule,
    ControlModule,
    ActivityModule,
    HistoryModule,
    ApprovalsModule,
    NotificationsModule,
    // Spec 201: the `local.request` router and action requests.
    LocalModule,
    TelegramModule,
    TerminalModule,
    SkillsModule,
    PlannerModule,
    // Spec 223: the design stage, on top of the Planner.
    DesignModule,
    // Issue #242: the project Board and its card workers.
    BoardModule,
    // Issue #244: candidate cards from manual sessions, into the Inbox.
    CaptureModule,
    SchedulesModule,
    BudgetsModule,
    // Before WebhooksModule: its `POST /hooks/:publicId` would otherwise
    // claim `/hooks/github` (spec 27 notes; pinned by an e2e test).
    GitHubAppModule,
    WebhooksModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}

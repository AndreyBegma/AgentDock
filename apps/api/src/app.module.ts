import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ActivityModule } from './activity';
import { AdminModule } from './admin/admin.module';
import { ApprovalsModule } from './approvals';
import { AssessModule } from './assess/assess.module';
import { AttachmentsModule } from './attachments/attachments.module';
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
import { HandoffModule } from './handoff';
import { HealthController } from './health.controller';
import { HistoryModule } from './history';
import { LiveModule } from './live/live.module';
import { LocalModule } from './local';
import { NotificationsModule } from './notifications';
import { PaneModule } from './pane';
import { PlannerModule } from './planner';
import { PricesModule } from './prices/prices.module';
import { ProjectRulesModule } from './project-rules';
import { ProjectsModule } from './projects/projects.module';
import { QueueModule } from './queue';
import { ReadinessModule } from './readiness';
import { RunnersModule } from './runners/runners.module';
import { SchedulesModule } from './schedules';
import { SessionsModule } from './sessions/sessions.module';
import { SkillsModule } from './skills';
import { StewardModule } from './steward';
import { StewardDigestModule } from './steward-digest';
import { TelegramModule } from './telegram';
import { TerminalModule } from './terminal';
import { TerminalSetupModule } from './terminal-setup';
import { TextModule } from './text';
import { TokenSaverModule } from './token-saver';
import { UsageModule } from './usage/usage.module';
import { WebhooksModule } from './webhooks';
import { WorkModule } from './work';
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
    // Issue #281: the Terminal → Board setup checklist.
    TerminalSetupModule,
    SkillsModule,
    PlannerModule,
    // Issue #272: the one runtime-profile rule and project readiness.
    ReadinessModule,
    // Spec 223: the design stage, on top of the Planner.
    DesignModule,
    // Issue #242: the project Board and its card workers.
    BoardModule,
    // Issue #244: candidate cards from manual sessions, into the Inbox.
    CaptureModule,
    // Issue #270: one Work surface — the List and the Board's plan tasks.
    WorkModule,
    // Issue #271: saved text normalized to English on the runner.
    TextModule,
    // Issue #445: Token saver. Global: every launch sender asks it what to send.
    TokenSaverModule,
    // Issue #447: Steward — incidents, safe automatic fixes, escalation.
    StewardModule,
    // Issue #449: Context handoff — note copies, person edits, restarts.
    HandoffModule,
    // Issue #322: a card's model recommended on the runner. Global, and here
    // alone: its conditional queue must not be registered while the graph loads.
    AssessModule,
    // Issue #309: attachments on board cards. Global, and `forRoot()` here:
    // its conditional queue must not be registered while the graph loads.
    AttachmentsModule.forRoot(),
    SchedulesModule,
    BudgetsModule,
    // Issue #528: per-project coding rules and their Markdown import.
    ProjectRulesModule,
    // Issue #447: the Steward digest. Global, and here alone: its conditional
    // queue must not be registered while the graph loads.
    StewardDigestModule,
    // Before WebhooksModule: its `POST /hooks/:publicId` would otherwise
    // claim `/hooks/github` (spec 27 notes; pinned by an e2e test).
    GitHubAppModule,
    WebhooksModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}

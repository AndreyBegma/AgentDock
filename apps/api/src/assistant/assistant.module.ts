import { Module } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import { ActivityModule } from '../activity/activity.module';
import { ApprovalsModule } from '../approvals/approvals.module';
import { AttachmentStore } from '../attachments/attachment-store';
import { AttachmentsStoreModule } from '../attachments/attachments-store.module';
import { uploadOptions } from '../attachments/upload-storage';
import { BoardModule } from '../board/board.module';
import { BudgetsModule } from '../budgets/budgets.module';
import { FleetModule } from '../fleet/fleet.module';
import { LlmModule } from '../llm/llm.module';
import { LocalModule } from '../local/local.module';
import { PricesModule } from '../prices/prices.module';
import { ProjectsModule } from '../projects';
import { QueueModule } from '../queue/queue.module';
import { ReadinessModule } from '../readiness';
import { RunnersModule } from '../runners/runners.module';
import { SessionsModule } from '../sessions/sessions.module';
import { AssistantController } from './assistant.controller';
import { AssistantAttachments } from './assistant-attachments.service';
import { AssistantChat } from './assistant-chat.service';
import { AssistantConversations } from './assistant-conversations.service';
import { AssistantModels } from './assistant-models';
import { AssistantBoardTools } from './tools/board-tools';
import { AssistantCodeTools } from './tools/code-tools';
import { AssistantToolRegistry } from './tools/registry';

/**
 * The assistant (ADR-0060): personal conversations streamed through the LLM
 * gateway (ADR-0059), with Board tools that act as the person and code tools
 * that ask the project's runner (ADR-0063). A module that
 * adds tools imports this one and registers them with `AssistantToolRegistry`.
 */
@Module({
  imports: [
    LlmModule,
    PricesModule,
    ProjectsModule,
    BoardModule,
    FleetModule,
    QueueModule,
    BudgetsModule,
    ActivityModule,
    SessionsModule,
    ApprovalsModule,
    LocalModule,
    RunnersModule,
    ReadinessModule,
    AttachmentsStoreModule,
    MulterModule.registerAsync({
      imports: [AttachmentsStoreModule],
      inject: [AttachmentStore],
      useFactory: uploadOptions,
    }),
  ],
  controllers: [AssistantController],
  providers: [
    AssistantToolRegistry,
    AssistantBoardTools,
    AssistantCodeTools,
    AssistantModels,
    AssistantAttachments,
    AssistantConversations,
    AssistantChat,
  ],
  // #620: the Telegram bot runs a chat's turns as its linked user.
  exports: [
    AssistantToolRegistry,
    AssistantConversations,
    AssistantAttachments,
    AssistantChat,
  ],
})
export class AssistantModule {}

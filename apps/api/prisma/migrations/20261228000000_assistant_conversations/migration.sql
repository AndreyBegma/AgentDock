-- CreateEnum
CREATE TYPE "AssistantMessageRole" AS ENUM ('user', 'assistant');

-- CreateEnum
CREATE TYPE "AssistantAttachmentKind" AS ENUM ('card', 'session', 'file');

-- CreateTable
CREATE TABLE "assistant_conversations" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "projectId" TEXT,
    "title" TEXT,
    "provider" "LlmProvider",
    "model" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assistant_conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assistant_messages" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "role" "AssistantMessageRole" NOT NULL,
    "content" TEXT NOT NULL,
    "displayContent" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "toolCalls" JSONB,
    "toolResults" JSONB,
    "provider" "LlmProvider",
    "model" TEXT,
    "llmCallIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assistant_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assistant_attachments" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "messageId" TEXT,
    "kind" "AssistantAttachmentKind" NOT NULL,
    "cardId" TEXT,
    "sessionId" TEXT,
    "attachmentId" TEXT,
    "label" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assistant_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "assistant_conversations_userId_updatedAt_idx" ON "assistant_conversations"("userId", "updatedAt");

-- CreateIndex
CREATE INDEX "assistant_messages_conversationId_createdAt_idx" ON "assistant_messages"("conversationId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "assistant_attachments_attachmentId_key" ON "assistant_attachments"("attachmentId");

-- CreateIndex
CREATE INDEX "assistant_attachments_conversationId_createdAt_idx" ON "assistant_attachments"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "assistant_attachments_messageId_idx" ON "assistant_attachments"("messageId");

-- AddForeignKey
ALTER TABLE "assistant_conversations" ADD CONSTRAINT "assistant_conversations_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assistant_conversations" ADD CONSTRAINT "assistant_conversations_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assistant_messages" ADD CONSTRAINT "assistant_messages_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "assistant_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assistant_attachments" ADD CONSTRAINT "assistant_attachments_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "assistant_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assistant_attachments" ADD CONSTRAINT "assistant_attachments_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "assistant_messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assistant_attachments" ADD CONSTRAINT "assistant_attachments_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "board_cards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assistant_attachments" ADD CONSTRAINT "assistant_attachments_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assistant_attachments" ADD CONSTRAINT "assistant_attachments_attachmentId_fkey" FOREIGN KEY ("attachmentId") REFERENCES "attachments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

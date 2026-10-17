-- AlterTable
ALTER TABLE "telegram_links" ADD COLUMN     "assistantConversationId" TEXT;

-- CreateIndex
CREATE INDEX "telegram_links_assistantConversationId_idx" ON "telegram_links"("assistantConversationId");

-- AddForeignKey
ALTER TABLE "telegram_links" ADD CONSTRAINT "telegram_links_assistantConversationId_fkey" FOREIGN KEY ("assistantConversationId") REFERENCES "assistant_conversations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
